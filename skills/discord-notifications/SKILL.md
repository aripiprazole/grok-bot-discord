---
name: discord-notifications
description: Turn Discord notifications for finished agent runs on or off. Use when the user wants to be pinged or notified on Discord when the agent finishes, or wants those notifications to stop.
---

# Agent-finished notifications

This plugin's `stop` hook posts `✅ Agent finished in <workspace>` to a Discord webhook when an agent run ends. On errors it posts `⚠️ … stopped with an error`. It stays quiet when the user aborts a run. Nothing is sent until a webhook is configured.

## Turn on

1. **Get a webhook URL.** If the user hasn't given one, tell them to open Discord → channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. It looks like `https://discord.com/api/webhooks/<id>/<token>`.
2. **Save it** to `~/.cursor/discord-bot.json` as `{"webhookUrl": "<url>"}`. Keep any other keys already in the file. Then run `chmod 600 ~/.cursor/discord-bot.json`.
3. **Test it:**
   ```sh
   curl -sS -H 'Content-Type: application/json' -d '{"content":"🔔 Agent notifications connected"}' "$(node -p 'require(process.env.HOME + "/.cursor/discord-bot.json").webhookUrl')"
   ```
   An empty response means it worked. Ask the user to confirm the message arrived.

## Turn off

Remove `webhookUrl` from `~/.cursor/discord-bot.json`, or delete the file.

## Notes

- The `DISCORD_WEBHOOK_URL` environment variable, if set, overrides the file.
- Anyone with the webhook URL can post to that channel. Never commit it, paste it into chat, or post it anywhere.
