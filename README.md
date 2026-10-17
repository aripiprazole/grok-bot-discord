# Discord Bot plugin

This plugin brings your bot to Discord, the way Grok Bot's Slack app works. Install it from the plugin marketplace, add a Discord bot token and an xAI API key, and you're done:

- **@mention it** in a channel and it answers in a thread. It keeps following that thread, so replies there don't need another mention.
- **DM it** and it answers every message.
- **`/join` in a voice channel** and you can talk with it using Grok realtime voice.
- **Tools for your agent:** read channels, post updates, reply, react, start threads, and join or leave calls.

> This is an unofficial plugin and is not affiliated with Discord Inc.

## Setup

1. **Create a Discord bot.** Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → **Bot**, then:
   - Click **Reset Token** and copy the token.
   - Turn on **Message Content Intent** under **Privileged Gateway Intents**.
2. **Get an xAI API key** at [console.x.ai](https://console.x.ai).
3. **Install the plugin** from the marketplace and fill in its settings:

   | Setting | Required | What it is |
   |---|---|---|
   | `DISCORD_BOT_TOKEN` | yes | The token from step 1 |
   | `XAI_API_KEY` | yes | Lets the bot answer with Grok and talk in voice calls |
   | `ALLOWED_IDS` | no | Comma-separated Discord user or role IDs allowed to use the bot. Leave it empty to allow everyone, but replies and voice minutes are billed to your xAI key. |
   | `LISTEN_CHANNEL_IDS` | no | Channels where the bot answers every message, not only @mentions |
   | `DISCORD_DEFAULT_CHANNEL_ID` | no | Where the agent posts when you don't name a channel |

4. **Invite the bot to your server.** Ask your agent for the Discord status (the `discord_status` tool). It prints an invite link with the right permissions, including Connect and Speak for voice.

## How it works

| Piece | Role |
|---|---|
| `server/index.mjs` | MCP server with the agent's Discord tools. It needs no dependencies. |
| `server/live/` | A background process that keeps the bot online. It answers messages with Grok and runs voice calls. The MCP server starts it, and it installs its own npm packages the first time it runs. |
| `skills/` | `discord`, `discord-catch-up`, `discord-post-update`, `discord-notifications` |
| `hooks/` | Optional "✅ Agent finished" pings to a Discord webhook |

**Background process:** it runs on the computer where the plugin runs, which for Grok Bot is the Bot's cloud computer. That lets it keep answering between agent sessions.
- There is one process per bot token.
- It restarts when you change the settings or update the plugin.
- It exits if the plugin is uninstalled.
- Its log path is shown by `discord_status`.

**Replies:** they come from Grok (`grok-4.7`, with web and X search) using your xAI key. The bot reads the thread or DM history back from Discord each time, so a restart loses nothing.

**Voice:** Discord audio is decoded and mixed, then sent to Grok realtime voice (`grok-voice-latest`), and Grok's audio is played back into the call.
- You can interrupt Grok by talking over it.
- `/join listen:Only me` makes it respond to you only.
- It leaves when the call empties, or after 60 minutes.
- xAI lists realtime voice at about $0.08 per minute.

**Requirements:** Node.js 22.12+ for the live connection. The tools alone work on Node.js 18.17+.

## Tools

| Tool | |
|---|---|
| `discord_status` | Online status, servers, active calls, invite link, and setup problems |
| `list_servers`, `list_channels` | Find where things are |
| `read_messages` | Read a channel or thread, oldest first |
| `send_message`, `edit_message`, `add_reaction`, `create_thread` | Post as the bot. @everyone, @here and role pings are always blocked. |
| `join_voice_channel`, `leave_voice_channel` | Voice calls |

Channel and message parameters accept raw IDs, `<#channel>` mentions, or `discord.com/channels/...` links.

## Safety

- **Allowlist:** `ALLOWED_IDS` limits who can make the bot spend your xAI credits. Anyone else gets a 🔒 reaction.
- **No pings:** the bot never pings anyone in its own replies.
- **Untrusted input:** message text from Discord is treated as untrusted. The agent is told not to follow instructions found inside it.
- **Secrets:** tokens live in the plugin settings, never in this repository.

## Development

```sh
npm install
npm test   # node:test with mocked Discord and xAI; no network needed
```

To try it in Cursor, link the folder into your local plugins directory and reload Cursor:

```sh
ln -s "$PWD" ~/.cursor/plugins/local/discord-bot
```

## License

MIT
