// Voice calls: /join brings Grok into your voice channel over Grok realtime voice; /leave ends it.

import { PassThrough } from "node:stream";
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { ChannelType, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import prism from "prism-media";
import { chunkMessage } from "../../format.mjs";
import { isAllowed } from "../config.mjs";
import { FRAME_MS, createUpmixer } from "./audio.mjs";
import { VoiceBridge, sessionConfig } from "./bridge.mjs";
import { connectRealtime } from "./realtime.mjs";

const CONNECT_TIMEOUT_MS = 20_000;
const SPEAKER_SILENCE_MS = 1_000;
// Buffer this much of each reply before playing so network jitter doesn't cause gaps (48 kHz stereo s16le).
const PREBUFFER_BYTES = 48_000 * 2 * 2 * 0.2;
// The player normally gives up after 100 ms without audio; tolerate pauses in Grok's stream instead.
const MAX_MISSED_FRAMES = 250;
const EPHEMERAL = { flags: MessageFlags.Ephemeral };

export const VOICE_COMMANDS = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bring Grok into your voice channel")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("listen")
        .setDescription("Who Grok listens to")
        .addChoices({ name: "Everyone in the call", value: "everyone" }, { name: "Only me", value: "me" }),
    ),
  new SlashCommandBuilder().setName("leave").setDescription("Make Grok leave the voice channel").setContexts(InteractionContextType.Guild),
].map((command) => command.toJSON());

function voiceInstructions({ botName, listen, persona, extra }) {
  return [
    persona ? `You are ${botName}. ${persona}` : `You are ${botName}, powered by Grok.`,
    `You're talking in a Discord voice call${listen === "everyone" ? " that may include several people" : ""}.`,
    "Speak naturally and keep replies short (one to three sentences) unless someone asks for detail.",
    "You only hear the call; you can't see the screen or the text chat. Stay in character.",
    extra,
  ]
    .filter(Boolean)
    .join("\n");
}

class VoiceSession {
  constructor({ channel, hostId, listen, persona, config, botName, log, onEnd }) {
    Object.assign(this, { channel, hostId, listen, persona, config, botName, log, onEnd });
    this.streams = new Map();
    this.upmix = createUpmixer();
    this.out = null;
    this.prebuffer = [];
    this.prebufferBytes = 0;
    this.stopped = false;
    this.live = false;
  }

  async start() {
    const { channel, config } = this;
    this.bridge = new VoiceBridge({
      send: (event) => this.realtime?.send(event),
      onAudio: (pcm) => this.play(pcm),
      onInterrupt: () => this.interrupt(),
      onResponseDone: () => this.endReply(),
      onTranscript: (text) => config.voice.transcripts && this.post(`🔊 **${this.botName}:** ${text}`),
      onError: (err) => this.log.warn(`Grok voice: ${err.message}`),
    });
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES } });
    this.player.on("error", (err) => this.log.warn(`Voice playback: ${err.message}`));

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    this.connection.subscribe(this.player);

    this.realtime = connectRealtime({
      apiKey: config.xaiApiKey,
      model: config.voice.model,
      session: sessionConfig({
        voice: config.voice.voice,
        instructions: voiceInstructions({ botName: this.botName, listen: this.listen, persona: this.persona, extra: config.systemPrompt }),
        tools: config.tools,
      }),
      onEvent: (event) => this.bridge.handleEvent(event),
      // Before the session is live, start() reports the failure instead.
      onClose: (code, reason) => this.live && this.stop(code === 1000 ? null : `Grok voice disconnected (${code}${reason ? `: ${reason}` : ""}).`),
    });
    await this.realtime.ready;
    this.live = true;

    this.connection.receiver.speaking.on("start", (userId) => this.hear(userId));
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Being moved between channels looks like a brief disconnect; only give up if it doesn't recover.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.stop("Disconnected from the voice channel.");
      }
    });
    this.ticker = setInterval(() => this.bridge.tick(), FRAME_MS);
    this.limit = setTimeout(() => this.stop(`Hit the ${config.voice.maxMinutes}-minute voice limit. Run /join to start again.`), config.voice.maxMinutes * 60_000);
  }

  canHear(userId) {
    if (this.channel.guild.members.cache.get(userId)?.user.bot) return false;
    return this.listen === "everyone" || userId === this.hostId;
  }

  hear(userId) {
    if (this.stopped || this.streams.has(userId) || !this.canHear(userId)) return;
    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SPEAKER_SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    this.streams.set(userId, opus);
    const cleanup = () => {
      if (this.streams.get(userId) === opus) this.streams.delete(userId);
      decoder.destroy();
    };
    opus.once("end", cleanup).once("close", cleanup);
    opus.on("error", (err) => this.log.warn(`Voice receive (${userId}): ${err.message}`));
    decoder.on("error", (err) => this.log.warn(`Opus decode (${userId}): ${err.message}`));
    opus.pipe(decoder).on("data", (pcm) => this.bridge.pushUserAudio(userId, pcm));
  }

  play(pcm) {
    const stereo = this.upmix(pcm);
    if (this.out) {
      this.out.write(stereo);
      return;
    }
    this.prebuffer.push(stereo);
    this.prebufferBytes += stereo.length;
    if (this.prebufferBytes >= PREBUFFER_BYTES) this.startReply();
  }

  startReply() {
    this.out = new PassThrough();
    for (const chunk of this.prebuffer) this.out.write(chunk);
    this.prebuffer = [];
    this.prebufferBytes = 0;
    this.player.play(createAudioResource(this.out, { inputType: StreamType.Raw }));
  }

  endReply() {
    if (!this.out && this.prebufferBytes) this.startReply(); // short reply that never filled the prebuffer
    this.out?.end();
    this.out = null;
  }

  interrupt() {
    this.prebuffer = [];
    this.prebufferBytes = 0;
    this.out?.destroy();
    this.out = null;
    this.player.stop(true);
  }

  post(text) {
    const target = this.channel.isTextBased() ? this.channel : null;
    for (const content of chunkMessage(text)) target?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.ticker);
    clearTimeout(this.limit);
    this.realtime?.close();
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    this.out?.destroy();
    this.player?.stop(true);
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    if (reason) this.post(`👋 ${reason}`);
    this.onEnd();
  }
}

export function createVoiceManager({ client, config, getPersona = () => null, log = console }) {
  const sessions = new Map(); // guild id → VoiceSession

  // Joins `channel`, listening to everyone or only `hostId`. Throws with a readable message on failure.
  async function joinChannel({ channel, hostId = null, listen = hostId ? "me" : "everyone", persona = getPersona() }) {
    if (!config.xaiApiKey) throw new Error("Voice calls need an xAI API key: set XAI_API_KEY in the plugin settings.");
    if (channel.type !== ChannelType.GuildVoice) throw new Error("I can only join regular voice channels.");
    if (!channel.joinable || !channel.speakable) throw new Error(`I need the Connect and Speak permissions in #${channel.name}.`);
    sessions.get(channel.guild.id)?.stop(null);
    const session = new VoiceSession({
      channel,
      hostId,
      listen,
      persona,
      config,
      botName: client.user.username,
      log,
      onEnd: () => sessions.get(channel.guild.id) === session && sessions.delete(channel.guild.id),
    });
    sessions.set(channel.guild.id, session);
    try {
      await session.start();
    } catch (err) {
      session.stop(null);
      throw new Error(`Couldn't start voice: ${err.message}`);
    }
    return session;
  }

  function leaveGuild(guildId) {
    const session = sessions.get(guildId);
    if (!session) return false;
    session.stop(null);
    return true;
  }

  async function slashJoin(interaction) {
    const channel = interaction.member.voice?.channel;
    if (!channel) return interaction.reply({ content: "Join a voice channel first, then run `/join`.", ...EPHEMERAL });
    await interaction.deferReply();
    const listen = interaction.options.getString("listen") ?? "everyone";
    try {
      await joinChannel({ channel, hostId: interaction.user.id, listen });
    } catch (err) {
      log.error(err);
      return interaction.editReply(`⚠️ ${err.message}`);
    }
    const who = listen === "me" ? "you" : "everyone";
    return interaction.editReply(`🎙️ Joined <#${channel.id}> and listening to ${who}. Just talk, and I'll answer when you pause. Run \`/leave\` to end the call.`);
  }

  return {
    joinChannel,
    leaveGuild,

    sessions: () => [...sessions.values()].map((s) => ({ server: s.channel.guild.name, channel: s.channel.name, listen: s.listen })),

    async handleInteraction(interaction) {
      if (!interaction.isChatInputCommand() || !["join", "leave"].includes(interaction.commandName)) return;
      if (!interaction.inCachedGuild()) return interaction.reply({ content: "Voice only works in servers.", ...EPHEMERAL });
      if (!isAllowed(interaction.user.id, interaction.member.roles.cache.keys(), config)) {
        return interaction.reply({ content: "🔒 You're not on this bot's allowlist.", ...EPHEMERAL });
      }
      if (interaction.commandName === "join") return slashJoin(interaction);
      if (!leaveGuild(interaction.guildId)) return interaction.reply({ content: "I'm not in a voice channel.", ...EPHEMERAL });
      return interaction.reply("👋 Left the voice channel.");
    },

    // Leave when the call empties, or when the only person being listened to leaves.
    onVoiceStateUpdate(oldState) {
      const session = sessions.get(oldState.guild.id);
      if (!session) return;
      const people = session.channel.members.filter((m) => !m.user.bot);
      if (!people.size) session.stop("Everyone left, so I did too.");
      else if (session.listen === "me" && !people.has(session.hostId)) session.stop("The person I was listening to left the call.");
    },

    stopAll(reason) {
      for (const session of sessions.values()) session.stop(reason);
    },
  };
}
