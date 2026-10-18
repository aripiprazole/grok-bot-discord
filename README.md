# Discord Bot plugin

This plugin puts your agents on Discord as themselves. It works like Grok Bot's Slack app, but each agent gets its own Discord bot and answers with its own memory, personality and tools.

- **@mention it** in a channel and it answers in a thread. It keeps following that thread, so replies there don't need another mention.
- **DM it** and it answers.
- **`/join` in a voice channel** and you can talk with it through ElevenLabs, speaking as its persona.
- **Tools for your agent:** read channels, post updates, reply, react, start threads, and join or leave calls.

> This is an unofficial plugin and is not affiliated with Discord Inc.

## How answers reach your agent

```
Discord message ──▶ plugin (always online) ──▶ 👀 + inbox
                                         └──▶ fires your routine's webhook
Grok Bot routine wakes your agent ──▶ check_discord_inbox ──▶ answers with its memory & tools ──▶ reply_on_discord
```

1. **Inbox.** A small background process keeps the bot online. Every @mention, DM and thread message goes into a durable inbox and gets a 👀 reaction.
2. **Wake-up.** The process calls the webhook of a Grok Bot routine on your agent (trigger "When a webhook fires", task "Run the discord-inbox skill"). The agent wakes within seconds.
   - Without a webhook, a routine on a 5-minute schedule works too.
3. **Answer.** The agent reads each conversation, answers in its own voice with `reply_on_discord`, and saves anything worth remembering to its own memory.
   - "Bot is typing…" shows while it works.
   - Channel @mentions get their own thread.

Prefer instant, memory-less replies? Set `REPLY_MODE=instant` and an xAI key, and Grok answers directly within seconds.

## Setup

1. **Create a Discord bot** at [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → **Bot**:
   - Click **Reset Token** and copy the token.
   - Turn on **Message Content Intent**.
2. **Install the plugin** on your Bot and set `DISCORD_BOT_TOKEN`.
3. **Ask your Bot to "set up Discord".** The `discord-setup` skill walks through the rest:
   - the invite link
   - the wake-up routine and its webhook
   - your agent's voice persona

| Setting | Required | What it is |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | The bot your agent speaks as. Use a different bot for each agent. |
| `ELEVENLABS_API_KEY` | for voice | Lets the bot talk in voice calls via ElevenLabs Agents |
| `ELEVENLABS_AGENT_ID`, `ELEVENLABS_VOICE_ID` | no | Use an existing ElevenLabs agent and voice. Empty creates or reuses an agent named `grok-bot-discord` |
| `XAI_API_KEY` | instant replies | Powers `REPLY_MODE=instant` only. Voice does not use it |
| `REPLY_MODE` | no | `agent` (default): your agent answers with its memory. `instant`: Grok answers right away. |
| `ROUTINE_WEBHOOK_URL`, `ROUTINE_WEBHOOK_KEY` | no | Your wake-up routine's webhook. The agent can also save these itself with `connect_discord_routine`. |
| `ALLOWED_IDS` | no | Comma-separated Discord user or role IDs allowed to talk to the bot. Leave it empty to allow everyone. |
| `ALLOWED_CHANNEL_IDS` | no | Channels the bot works in. It ignores other server channels; threads count by their parent channel, and DMs aren't affected. |
| `LISTEN_CHANNEL_IDS` | no | Channels where every message reaches the agent, not only @mentions |
| `DISCORD_DEFAULT_CHANNEL_ID` | no | Where the agent posts when you don't name a channel |

## Without the marketplace (personal Grok Bots, any agent with a shell)

The same package works as a command-line tool. A personal Grok Bot can use it from its own computer:

```sh
npm install -g github:aripiprazole/grok-bot-discord   # or prefix each command with: npx -y github:aripiprazole/grok-bot-discord
mkdir -p ~/.discord-bot-plugin && printf 'DISCORD_BOT_TOKEN=...\nELEVENLABS_API_KEY=...\n' > ~/.discord-bot-plugin/.env && chmod 600 ~/.discord-bot-plugin/.env
grok-bot-discord discord_status
grok-bot-discord check_discord_inbox
grok-bot-discord reply_on_discord '{"item_id":"3f9a1c2e","content":"On it!"}'
grok-bot-discord help   # every tool and its arguments
```

## Tools

| Tool | |
|---|---|
| `discord_status` | Online status, servers, inbox, wake-up webhook, voice, invite link, setup problems |
| `check_discord_inbox`, `reply_on_discord`, `skip_discord_message` | Answer people as yourself |
| `connect_discord_routine` | Save the wake-up routine's webhook |
| `set_discord_persona` | Who you are in voice calls started from Discord |
| `join_voice_channel`, `leave_voice_channel`, `say_in_voice_call` | Voice calls; pass `persona` to say who to be, and speak an agent's answer into the live call |
| `list_servers`, `list_channels`, `read_messages` | Look around. Edited and deleted messages are marked when the hosted gateway has seen them |
| `send_message`, `edit_message`, `add_reaction`, `create_thread` | Post as the bot. `send_message` can attach embeds, components, or a poll. @everyone, @here and role pings are always blocked |

**Skills:**

| Skill | Purpose |
|---|---|
| `discord-setup` | One-time setup |
| `discord-inbox` | What the routine runs |
| `discord` | Tool guide |
| `discord-catch-up` | Summarize a channel |
| `discord-post-update` | Post a status update |
| `discord-notifications` | Optional "✅ Agent finished" pings to a webhook |

## Details

- **Background process:** it runs where the plugin runs, which for Grok Bot is the Bot's cloud computer. It survives agent sessions and keeps the inbox on disk.
  - There is one process per bot token.
  - It restarts when you change the settings or update the plugin.
  - It exits if the plugin is uninstalled.
  - It installs its npm packages on first run.
  - It needs Node.js 22.12+. The tools alone need Node.js 18.17+.
- **Inbox:** items the agent claims are held for 10 minutes and come back if they're never answered. Items older than a day are dropped.
- **Re-wake:** if messages wait over 2 minutes unclaimed (say a routine run failed), the process fires the webhook again, at most every 10 minutes.
- **Voice:** Discord audio goes to an ElevenLabs Conversational AI agent with the bot's persona, and that agent's speech is played back into the call.
  - You can interrupt it by talking over it.
  - `/join listen:Only me` makes it respond to you only.
  - It leaves when the call empties, or after 60 minutes.
  - When someone on the call asks for something that needs memory or tools, the voice agent calls `ask_agent`. That wakes your routine. Answer with `say_in_voice_call` so the result is spoken in the call.
  - ElevenLabs bills the call on your ElevenLabs account. The first call can create an agent named `grok-bot-discord` and attach the `ask_agent` client tool. Set `ELEVENLABS_AGENT_ID` to use an agent you already configured. That agent still gets `ask_agent` attached, and per-call persona or voice overrides only apply if the agent allows them.
- **Safety:**
  - Discord text is untrusted input. The agent is told never to follow instructions inside it, and to ask its owner before risky actions.
  - `ALLOWED_IDS` limits who can reach the agent.
  - Secrets stay in the plugin settings and are never in this repository.

## Run on Cloudflare

The hosted bot does not need a personal computer. A Worker serves MCP. One Durable Object keeps the Discord gateway and the inbox. Voice cannot run on the Worker: Discord voice is UDP, and Workers cannot send UDP. On the Workers Free plan the voice host is a Fly.io Machine. A Cloudflare Container remains available on a paid Workers plan.

Tradeoff: the gateway, inbox, MCP, and webhooks stay on a Worker, which is the cheap always-on part. An outbound WebSocket to Discord keeps that Durable Object alive, with a 30 second alarm and a cron trigger as backup. Each voice call starts a Container (`basic` instance, internet on so UDP to Discord works) and talks to ElevenLabs over a WebSocket. Containers need a paid Workers plan, Docker on the machine that runs `wrangler deploy`, and a few seconds of cold start when someone joins. The `durable_object` scheduling policy picks the image and instance size in code; concurrent calls count against the account's container quota, one container per server.

### Deploy

```sh
cd cloudflare
npm install
npx wrangler login
npx wrangler secret put DISCORD_BOT_TOKEN --config ../wrangler.jsonc
npx wrangler secret put MCP_AUTH_TOKEN --config ../wrangler.jsonc
npx wrangler secret put ELEVENLABS_API_KEY --config ../wrangler.jsonc
# optional
npx wrangler secret put ELEVENLABS_AGENT_ID --config ../wrangler.jsonc
npx wrangler secret put ELEVENLABS_VOICE_ID --config ../wrangler.jsonc
npx wrangler secret put ROUTINE_WEBHOOK_URL --config ../wrangler.jsonc
npx wrangler secret put ROUTINE_WEBHOOK_KEY --config ../wrangler.jsonc
npx wrangler secret put ALLOWED_CHANNEL_IDS --config ../wrangler.jsonc
npx wrangler secret put XAI_API_KEY --config ../wrangler.jsonc   # only for REPLY_MODE=instant
npx wrangler deploy --config ../wrangler.jsonc
```

`XAI_API_KEY` is not required. Voice uses `ELEVENLABS_API_KEY`. Leave it unset and voice calls fail with a clear error; text and the inbox still work.

Turn on Message Content Intent for the Discord application. The cron starts the gateway even before the first MCP call.

On the hosted bot, `send_message` and `reply_on_discord` accept embeds, buttons, select menus, and polls. Presses and selections are acknowledged and queued in the inbox. `MESSAGE_UPDATE` and `MESSAGE_DELETE` update that inbox, and context reads mark messages edited or deleted. That gateway behavior is part of the Worker, not the local Node process.

### Free plan (no voice) and the gateway switch

On the Workers Free plan, deploy with `wrangler.novoice.jsonc`: the same Worker and SQLite-backed Durable Object, without the voice container. Voice tools then answer "Voice hosting isn't configured."

```sh
npx wrangler deploy --config ../wrangler.novoice.jsonc
```

`GATEWAY_ENABLED` (a var, default `true`) controls the Discord gateway connection. With `"false"`, neither the cron nor MCP calls open the gateway, and REST tools still work. Use that while another process runs the same bot token. Set it to `"true"` and redeploy to cut over. `wrangler.novoice.jsonc` sets it to `"true"`.

From `cloudflare/`, `npm run deploy:novoice` and `npm run check:novoice` use that config. `npm run check:novoice` is a dry run and does not need Docker.

### Voice on Fly.io

The free-plan Worker stays as it is. Voice runs on one always-on Fly Machine in São Paulo (`gru`), `shared-cpu-1x` with 512 MB. `auto_stop_machines` is `"off"` and `min_machines_running` is 1. Discord voice UDP leaves the Machine directly; nothing publishes a public UDP port. The image is the same `voice.Dockerfile` the Container path uses.

The Durable Object opens `wss://<app>.fly.dev/control` with `Authorization: Bearer <VOICE_HOST_SECRET>` when `VOICE_HOST` (the Container binding) is absent and both `VOICE_HOST_URL` and `VOICE_HOST_SECRET` are set. It forwards `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE`, and sends the voice host's gateway payloads back out the Discord gateway. `join_voice_channel`, `leave_voice_channel`, `say_in_voice_call`, `/join`, and `/leave` use that socket. `ask_agent` still posts the routine webhook from the Durable Object, so `ROUTINE_WEBHOOK_URL` and `ROUTINE_WEBHOOK_KEY` stay on the Worker.

If the Container binding is present (`wrangler.jsonc`), it wins and Fly is not used.

One-time setup, from the repo root (install [flyctl](https://fly.io/docs/flyctl/install/) first). Change the app name in `fly.toml` if `grok-bot-discord-voice` is taken:

```sh
fly auth login
fly apps create grok-bot-discord-voice
fly secrets set \
  VOICE_HOST_SECRET="$(openssl rand -hex 32)" \
  ELEVENLABS_API_KEY="..." \
  -a grok-bot-discord-voice
# optional
fly secrets set ELEVENLABS_AGENT_ID="..." ELEVENLABS_VOICE_ID="..." -a grok-bot-discord-voice
fly deploy --ha=false
```

`--ha=false` keeps a single Machine. `fly status` should show one started Machine in `gru`. Then point the live Worker at it (this deploys a new Worker version):

```sh
cd cloudflare
npx wrangler secret put VOICE_HOST_URL --config ../wrangler.novoice.jsonc
# https://grok-bot-discord-voice.fly.dev
npx wrangler secret put VOICE_HOST_SECRET --config ../wrangler.novoice.jsonc
# the same VOICE_HOST_SECRET value
```

`discord_status` then says `Voice calls: on (Fly.io)`. `ELEVENLABS_API_KEY` on the Worker is optional in this setup: the Fly Machine supplies it. If the Worker secret is also set, that value is sent on the control socket and used instead.

Do not set `DISCORD_BOT_TOKEN` on Fly. The Durable Object already holds the gateway. Do not set `ROUTINE_WEBHOOK_URL` or `ROUTINE_WEBHOOK_KEY` on Fly. The voice bridge posts from the Worker.

#### Deploy the Fly voice host from GitHub Actions

[`.github/workflows/deploy-fly-voice.yml`](.github/workflows/deploy-fly-voice.yml) is `workflow_dispatch` only. It does not run on push. Create the Fly app and set the Fly secrets above first. Add the repository secret `FLY_API_TOKEN` (Settings → Secrets and variables → Actions; `fly tokens create deploy` or a token that can deploy this app), then start **Deploy voice on Fly**. The workflow runs `flyctl deploy --remote-only --ha=false`. It does not set secrets.

### Deploy the Cloudflare Container from GitHub Actions

The Container path needs a paid Workers plan. The voice image is built with Docker during `wrangler deploy`. GitHub-hosted runners include Docker, so the manual workflow [`.github/workflows/deploy-voice.yml`](.github/workflows/deploy-voice.yml) can deploy the full config from Actions. It does not run on push. Add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Settings → Secrets and variables → Actions), then start **Deploy with voice** from the Actions tab. The workflow runs `npx wrangler deploy --config ../wrangler.jsonc`. The token needs permission to deploy Workers and Container images. Wrangler reads those two variables itself. On that config the `VOICE_HOST` binding is present, so the Worker uses the Container and ignores `VOICE_HOST_URL`.

### Remote MCP

```text
https://grok-bot-discord.<account>.workers.dev/mcp
Authorization: Bearer <MCP_AUTH_TOKEN>
```

`POST` one JSON-RPC message at a time (`initialize`, `tools/list`, `tools/call`). `Accept: text/event-stream` returns the same reply as one SSE event. `GET /mcp` is 405. A WebSocket speaks the same JSON-RPC at `wss://grok-bot-discord.<account>.workers.dev/mcp/ws`. Query `?token=` works for clients that cannot set headers; prefer the Authorization header. `GET /health` is public and returns no secrets.

The Worker does not use the Agents SDK `McpAgent` class. The tools stay defined once, in `server/tools.mjs`, and a thin Streamable HTTP wrapper calls the same handler as the local stdio server.

## Development

```sh
npm install
npm test      # node:test with mocked Discord, xAI and webhooks
npm run dev   # run the live connection locally with the settings in .env
```

To try it in Cursor, link the folder into your local plugins directory:

```sh
ln -s "$PWD" ~/.cursor/plugins/local/discord-bot
```

## License

MIT
