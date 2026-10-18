# Changelog

## 0.5.1 — 2026-10-18

- **Voice survives restarts.** The Cloudflare bot saves who is in each voice channel. After a deploy the gateway resumes without replaying GUILD_CREATE, so the bot used to think every call was empty and left right after joining. With no saved voice states it no longer guesses that everyone left, and `/join` asks Discord where you are.

## 0.5.0 — 2026-10-18

- **Voice is transcription + speech only.** Calls no longer run an ElevenLabs conversational agent. Each speaker is transcribed in real time with ElevenLabs Scribe v2 Realtime (with per-utterance language detection), finished utterances go to the routine webhook as `source: discord-voice` with speaker and language, and the agent answers with `say_in_voice_call`, spoken by ElevenLabs text-to-speech (`eleven_flash_v2_5`, multilingual). `ELEVENLABS_AGENT_ID` and the `ask_agent` tool are gone; `ELEVENLABS_TTS_MODEL` is new. `say_in_voice_call` takes an optional `language`.
- **Answers follow the speaker's language.** Voice transcripts carry the detected language, and the built-in prompts no longer assume English.
- **Inline replies by default.** `reply_on_discord` replies to the message in the channel; pass `thread: true` to start a thread. Instant mode replies inline too.
- **Readable thread titles.** Titles resolve `<@id>`, `<@!id>`, `<@&role>` and `<#channel>` to names, drop the leading bot ping, and cut at a word boundary.
- **Other bots reach the inbox.** Messages from other bots are queued like anyone's and marked as bots. Only the bot's own messages and its own webhook posts are ignored. Instant mode still ignores bots.

## 0.4.0 — 2026-10-18

- **Cloudflare.** The bot can run entirely on Cloudflare: a Worker serves the remote MCP endpoint, a Durable Object holds the Discord gateway and inbox, and a Container per voice call carries Discord's UDP audio.
- **ElevenLabs voice.** Voice calls use ElevenLabs Conversational AI instead of xAI realtime voice. Set `ELEVENLABS_API_KEY`. `ELEVENLABS_AGENT_ID` and `ELEVENLABS_VOICE_ID` are optional. `XAI_API_KEY` is only for `REPLY_MODE=instant`.
- **Voice bridge.** During a call the ElevenLabs agent can call `ask_agent`, which wakes the Grok Bot routine. Speak the answer back with `say_in_voice_call`.
- **Inline replies.** `reply_on_discord` takes `thread: false` to answer a channel @mention in the channel instead of starting a thread.
- **Hosted rich messages.** On the Cloudflare bot, `send_message` and `reply_on_discord` can attach embeds, buttons, select menus, and polls. Button presses and menu selections are queued in the inbox.
- **Hosted edits and deletes.** The Cloudflare gateway listens for `MESSAGE_UPDATE` and `MESSAGE_DELETE`. Inbox transcripts and `read_messages` mark those messages edited or deleted.

## 0.3.0 — 2026-10-17

- **Agent mode** (the default): Discord messages go to an inbox, marked 👀, and your agent answers them as itself, with its own memory and tools.
  - New tools: `check_discord_inbox`, `reply_on_discord`, `skip_discord_message`.
- **Instant wake-up:** a Grok Bot routine with a "When a webhook fires" trigger wakes your agent within seconds. Connect it with `connect_discord_routine` or with the `ROUTINE_WEBHOOK_URL` and `ROUTINE_WEBHOOK_KEY` settings. Unanswered messages trigger a new wake-up.
- **Persona for voice calls:** `set_discord_persona`, and a `persona` option on `join_voice_channel`.
- New skills: `discord-setup` and `discord-inbox`.
- `XAI_API_KEY` is now optional. It's only needed for voice calls and for `REPLY_MODE=instant`.

## 0.2.0 — 2026-10-17

- The bot now stays online in Discord. It answers @mentions in a thread and follows that thread, answers DMs, and answers every message in `LISTEN_CHANNEL_IDS`, all with Grok.
- Voice calls: `/join` and `/leave` in Discord, plus the `join_voice_channel` and `leave_voice_channel` tools, using Grok realtime voice.
- New `discord_status` tool, and new settings: `XAI_API_KEY` (required), `ALLOWED_IDS`, `LISTEN_CHANNEL_IDS`.

## 0.1.0 — 2026-10-17

- First release: a `discord` MCP server with seven tools, four skills, and an opt-in `stop` hook for agent-finished notifications.
