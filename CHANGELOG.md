# Changelog

## 0.2.0 — 2026-10-17

- The bot now stays online in Discord. It answers @mentions in a thread and follows that thread, answers DMs, and answers every message in `LISTEN_CHANNEL_IDS`, all with Grok.
- Voice calls: `/join` and `/leave` in Discord, plus the `join_voice_channel` and `leave_voice_channel` tools, using Grok realtime voice.
- New `discord_status` tool, and new settings: `XAI_API_KEY` (required), `ALLOWED_IDS`, `LISTEN_CHANNEL_IDS`.

## 0.1.0 — 2026-10-17

- First release: a `discord` MCP server with seven tools, four skills, and an opt-in `stop` hook for agent-finished notifications.
