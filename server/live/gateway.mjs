// The live Discord connection: answers DMs, mentions and threads with Grok, and runs voice calls.

import { ChannelType, Client, Events, GatewayIntentBits, OAuth2Scopes, Partials, PermissionFlagsBits } from "discord.js";
import { createChatHandler } from "./chat.mjs";
import { createGrok } from "./grok.mjs";
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

export async function startGateway({ config, log }) {
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
  const grok = createGrok({ apiKey: config.xaiApiKey, model: config.model, tools: config.tools });
  const onMessage = createChatHandler({ client, config, grok, log });
  const voice = createVoiceManager({ client, config, log });

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
  log.info(`Online as ${client.user.tag} in ${client.guilds.cache.size} server(s)`);

  return {
    status: () => ({
      user: client.user.tag,
      servers: client.guilds.cache.map((g) => g.name),
      invite,
      voice: voice.sessions(),
    }),

    async join({ channelId, listenToUserId }) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error("That isn't a voice channel the bot can see.");
      await voice.joinChannel({ channel, hostId: listenToUserId ?? null });
      return `Joined 🔊 ${channel.name} in ${channel.guild.name}, listening to ${listenToUserId ? `<@${listenToUserId}> only` : "everyone"}.`;
    },

    leave({ serverId }) {
      const guildIds = serverId ? [serverId] : [...client.guilds.cache.keys()];
      const left = guildIds.filter((id) => voice.leaveGuild(id));
      return left.length ? "Left the voice channel." : "The bot isn't in a voice channel.";
    },

    async stop(reason) {
      voice.stopAll(reason);
      await client.destroy();
    },
  };
}
