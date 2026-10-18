// Voice calls: /join brings the bot into a voice channel and talks through ElevenLabs Agents.

import { ChannelType, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { channelAllowed, isAllowed } from "../config.mjs";
import { chunkMessage } from "../../format.mjs";
import { bindElevenToConnection } from "./eleven-call.mjs";
import { fireVoiceRequest, voiceInstructions } from "./prompt.mjs";

const CONNECT_TIMEOUT_MS = 20_000;
const EPHEMERAL = { flags: MessageFlags.Ephemeral };

export const VOICE_COMMANDS = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bring the bot into your voice channel")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("listen")
        .setDescription("Who the bot listens to")
        .addChoices({ name: "Everyone in the call", value: "everyone" }, { name: "Only me", value: "me" }),
    ),
  new SlashCommandBuilder().setName("leave").setDescription("Make the bot leave the voice channel").setContexts(InteractionContextType.Guild),
].map((command) => command.toJSON());

class VoiceSession {
  constructor({ channel, hostId, listen, persona, config, botName, log, onEnd, onAgentRequest }) {
    Object.assign(this, { channel, hostId, listen, persona, config, botName, log, onEnd, onAgentRequest });
    this.stopped = false;
    this.binder = null;
    this.connection = null;
  }

  async start() {
    const { channel } = this;
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    this.binder = bindElevenToConnection(this.connection, {
      apiKey: this.config.elevenApiKey,
      agentId: this.config.voice.agentId,
      voiceId: this.config.voice.voiceId,
      instructions: voiceInstructions({
        botName: this.botName,
        listen: this.listen,
        persona: this.persona,
        extra: this.config.systemPrompt,
      }),
      canHear: (userId) => this.canHear(userId),
      onTranscript: (text) => this.config.voice.transcripts && this.post(`🔊 **${this.botName}:** ${text}`),
      onError: (err) => this.log.warn(`ElevenLabs voice: ${err.message}`),
      onAgentRequest: (payload) => this.onAgentRequest?.(payload),
      onClose: (code, reason) => this.stop(code === 1000 ? null : `ElevenLabs disconnected (${code}${reason ? `: ${reason}` : ""}).`),
      onLimit: (reason) => this.stop(reason),
      callInfo: {
        guildId: channel.guild.id,
        channelId: channel.id,
        place: `🔊 ${channel.name} (${channel.guild.name})`,
        listen: this.listen,
        hostId: this.hostId,
      },
      maxMinutes: this.config.voice.maxMinutes,
      log: this.log,
    });
    await this.binder.ready;
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.stop("Disconnected from the voice channel.");
      }
    });
  }

  canHear(userId) {
    if (this.channel.guild.members.cache.get(userId)?.user.bot) return false;
    return this.listen === "everyone" || userId === this.hostId;
  }

  say(content) {
    if (!this.binder) throw new Error("The voice call isn't connected yet.");
    this.binder.say(content);
  }

  post(text) {
    const target = this.channel.isTextBased() ? this.channel : null;
    for (const content of chunkMessage(text)) target?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.binder?.stop();
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    if (reason) this.post(`👋 ${reason}`);
    this.onEnd();
  }
}

export function createVoiceManager({ client, config, getPersona = () => null, getWebhook = () => null, log = console }) {
  const sessions = new Map();

  async function joinChannel({ channel, hostId = null, listen = hostId ? "me" : "everyone", persona = getPersona() }) {
    if (!config.elevenApiKey) throw new Error("Voice calls need an ElevenLabs API key: set ELEVENLABS_API_KEY.");
    if (channel.type !== ChannelType.GuildVoice) throw new Error("I can only join regular voice channels.");
    if (!channelAllowed(channel, config)) throw new Error(`#${channel.name} isn't in this bot's allowed channels (ALLOWED_CHANNEL_IDS).`);
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
      onAgentRequest: ({ request, call }) => {
        fireVoiceRequest({ webhook: getWebhook?.() ?? config.routineWebhook, request, call, log }).catch(() => {});
      },
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

  function say({ serverId, content }) {
    const text = content?.trim();
    if (!text) throw new Error("content must be a non-empty string.");
    const targets = serverId ? [sessions.get(serverId)].filter(Boolean) : [...sessions.values()];
    if (!targets.length) throw new Error(serverId ? "The bot isn't in a voice channel on that server." : "The bot isn't in a voice channel.");
    for (const session of targets) session.say(text);
    return `Speaking in ${targets.map((s) => `🔊 ${s.channel.name}`).join(", ")}.`;
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
    say,
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
