// Slash commands registered on the Discord gateway, without discord.js builders.

export const INVITE_PERMISSIONS = (
  (1n << 6n) | // AddReactions
  (1n << 10n) | // ViewChannel
  (1n << 11n) | // SendMessages
  (1n << 14n) | // EmbedLinks
  (1n << 16n) | // ReadMessageHistory
  (1n << 20n) | // Connect
  (1n << 21n) | // Speak
  (1n << 35n) | // CreatePublicThreads
  (1n << 38n) // SendMessagesInThreads
).toString();

export const VOICE_COMMANDS = [
  {
    name: "join",
    description: "Bring the bot into your voice channel",
    contexts: [0],
    options: [
      {
        name: "listen",
        description: "Who the bot listens to",
        type: 3,
        choices: [
          { name: "Everyone in the call", value: "everyone" },
          { name: "Only me", value: "me" },
        ],
      },
    ],
  },
  {
    name: "leave",
    description: "Make the bot leave the voice channel",
    contexts: [0],
  },
];
