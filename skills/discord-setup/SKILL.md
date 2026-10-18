---
name: discord-setup
description: One-time setup so you can live on Discord as yourself. It invites the bot to a server, connects the routine that wakes you whenever someone messages you, and saves your persona for voice calls. Use when the user installs the Discord plugin, or asks to set up, connect, or turn on Discord.
---

# Set up Discord

1. **Check the connection.** Call `discord_status`.
   - **Problem reported:** tell the user exactly what to fix. Typical problems are a missing `DISCORD_BOT_TOKEN`, a rejected token, or Message Content Intent being off. Then stop.
   - **No servers yet:** give the user the invite link and wait until they've added the bot.
2. **Create the wake-up routine.** Use Grok Bot's routines:
   - **Name:** "Discord inbox"
   - **Trigger:** "When a webhook fires"
   - **Task:** "Run the discord-inbox skill."
3. **Connect it.** The routine's settings show a **Webhook URL** and a **Webhook key**. Then either:
   - call `connect_discord_routine(webhook_url, webhook_key)` yourself if you can see them, or
   - ask the user to copy both into the plugin settings (`ROUTINE_WEBHOOK_URL`, `ROUTINE_WEBHOOK_KEY`), or to paste them to you.

   Now every new Discord message wakes you within seconds.

   **If webhook triggers aren't available:** make the routine run on a schedule instead, every 5 minutes (the shortest allowed). Confirm that with the user, since every run uses usage.
4. **Save your persona.** Call `set_discord_persona` with a short description of yourself, written as instructions:
   - your name, personality and way of talking
   - anything about your owner or their community you'd want to know in a voice call

   Instant replies use it.
5. **Test it.** Ask the user to @mention the bot in Discord.
   - The message should get 👀 right away and an answer from you shortly after.
   - `discord_status` shows the inbox and when the webhook last fired.
6. **Explain how it works.** Tell the user:
   - People @mention you in a channel (you reply right there), DM you, or keep talking in your threads, and you answer as yourself.
   - In a voice channel, `/join` brings you in and `/leave` ends the call.
