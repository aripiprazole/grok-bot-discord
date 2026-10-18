// The live Discord connection: collects @mentions, DMs and thread messages for the agent (or answers
// them with Grok in instant mode) and runs voice calls.

import { join } from "node:path";
import { ChannelType, Client, Events, GatewayIntentBits, OAuth2Scopes, Partials, PermissionFlagsBits } from "discord.js";
import { createAgentInbox } from "./agent-inbox.mjs";
import { createChatHandler } from "./chat.mjs";
import { effectiveReplyMode } from "./config.mjs";
import { createGrok } from "./grok.mjs";
import { Inbox, readJson, writeJson } from "./inbox.mjs";
import { Waker, checkWebhook } from "./waker.mjs";
import { VOICE_COMMANDS, createVoiceManager } from "./voice/voice.mjs";

const INVITE_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];
const MAX_PERSONA = 4_000;
// If messages sit unclaimed (say a routine run failed), wake the agent again, but not too often.
const REWAKE_AFTER_MS = 2 * 60_000;
const REWAKE_SPACING_MS = 10 * 60_000;

export async function startGateway({ config, dataDir, log }) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel], // DM channels aren't cached until their first message
  });

  const personaFile = join(dataDir, "persona.json");
  const getPersona = () => readJson(personaFile, {}).persona ?? null;
  const replyMode = effectiveReplyMode(config);
  const routineFile = join(dataDir, "routine.json");
  const getWebhook = () => (config.routineWebhook.url ? config.routineWebhook : readJson(routineFile, null));
  const followedThreads = new Set();
  const inbox = new Inbox({ file: join(dataDir, "inbox.json") });
  const waker = new Waker({ getWebhook, pending: () => inbox.waiting().count, log });
  const agentInbox = createAgentInbox({ client, inbox, followedThreads, onNewMessage: () => waker.notify(), log });
  const rewake = setInterval(() => {
    if (inbox.waiting().oldestMs > REWAKE_AFTER_MS && Date.now() - waker.lastFiredAt > REWAKE_SPACING_MS) waker.notify();
  }, REWAKE_AFTER_MS);
  rewake.unref();
  const grok = config.xaiApiKey ? createGrok({ apiKey: config.xaiApiKey, model: config.model, tools: config.tools }) : null;
  const onMessage = createChatHandler({ client, config, grok, agentInbox: replyMode === "agent" ? agentInbox : null, followedThreads, getPersona, log });
  const voice = createVoiceManager({ client, config, getPersona, getWebhook, log });

  client.on(Events.MessageCreate, (message) => onMessage(message).catch((err) => log.error(err)));
  client.on(Events.InteractionCreate, (interaction) => voice.handleInteraction(interaction).catch((err) => log.error(err)));
  client.on(Events.VoiceStateUpdate, (oldState) => voice.onVoiceStateUpdate(oldState));
  client.on(Events.Error, (err) => log.error(err));

  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  try {
    await client.login(config.token);
  } catch (err) {
    if (/disallowed intents/i.test(err.message)) {
      throw new Error("Discord refused the connection: turn on Message Content Intent (Developer Portal → your app → Bot → Privileged Gateway Intents).");
    }
    throw err;
  }
  await ready;
  await client.application.commands.set(VOICE_COMMANDS);
  const invite = client.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: INVITE_PERMISSIONS });
  log.info(`Online as ${client.user.tag} in ${client.guilds.cache.size} server(s), ${replyMode} replies. Invite link: ${invite}`);

  return {
    status: () => ({
      user: client.user.tag,
      servers: client.guilds.cache.map((g) => g.name),
      invite,
      replyMode,
      inbox: agentInbox.stats(),
      persona: Boolean(getPersona()),
      wake: waker.status(),
      voiceEnabled: Boolean(config.elevenApiKey),
      voice: voice.sessions(),
    }),

    inbox: agentInbox,

    setPersona({ persona }) {
      const text = persona?.trim() ?? "";
      if (text.length > MAX_PERSONA) throw new Error(`Keep the persona under ${MAX_PERSONA} characters (got ${text.length}).`);
      writeJson(personaFile, { persona: text || null, updatedAt: new Date().toISOString() });
      return text ? "Saved. Instant replies will use this persona." : "Persona cleared.";
    },

    setRoutineWebhook({ url, key }) {
      const webhook = { url: url?.trim(), key: key?.trim().replace(/^Bearer\s+/i, "") };
      const problem = checkWebhook(webhook);
      if (problem) throw new Error(problem);
      writeJson(routineFile, webhook);
      waker.notify();
      return config.routineWebhook.url
        ? "Saved, but the webhook in the plugin settings takes priority. Clear ROUTINE_WEBHOOK_URL there to use this one."
        : "Connected. New Discord messages now wake your routine within seconds.";
    },

    async join({ channelId, listenToUserId, persona }) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error("That isn't a voice channel the bot can see.");
      await voice.joinChannel({ channel, hostId: listenToUserId ?? null, ...(persona?.trim() ? { persona: persona.trim() } : {}) });
      return `Joined 🔊 ${channel.name} in ${channel.guild.name}, listening to ${listenToUserId ? `<@${listenToUserId}> only` : "everyone"}.`;
    },

    leave({ serverId }) {
      const guildIds = serverId ? [serverId] : [...client.guilds.cache.keys()];
      const left = guildIds.filter((id) => voice.leaveGuild(id));
      return left.length ? "Left the voice channel." : "The bot isn't in a voice channel.";
    },

    say({ serverId, content, language }) {
      return voice.say({ serverId, content, language });
    },

    async stop(reason) {
      clearInterval(rewake);
      voice.stopAll(reason);
      await client.destroy();
    },
  };
}
