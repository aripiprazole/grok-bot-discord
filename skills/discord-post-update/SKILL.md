---
name: discord-post-update
description: Write and post a short status update about the work done in this session to a Discord channel. Use when the user asks to share progress, announce a change, post a summary, or tell the team on Discord.
---

# Post an update to Discord

1. **Gather facts.** Use this conversation plus read-only git commands: `git status --short`, `git log --oneline -n 10`, `git diff --stat`. If a PR or branch exists, get its URL.
2. **Draft** about 1,200 characters or less:

   ```
   **<one-line headline: what shipped or changed>**
   - What changed and why (2–5 bullets)
   - Links: PR / branch / commit
   - Anything reviewers need to do, plus known gaps
   ```

3. **Scrub** secrets, tokens, `.env` values, internal hostnames, and customer names.
4. **Choose the destination.** Use the channel the user named, otherwise the default channel.
   - If the user named the channel or said "post it", send it.
   - Otherwise show the draft and the destination, then wait for confirmation.
5. **Send** with `send_message`. Use `silent: true` unless the user wants people notified. Reply with the jump link.
