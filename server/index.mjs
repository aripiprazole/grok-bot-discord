#!/usr/bin/env node
import { createLiveClient } from "./live/client.mjs";
import { SERVER_INFO, serve } from "./server.mjs";

// Keeps the bot online in Discord (mentions, DMs, threads, voice) in a background process.
const live = createLiveClient({ version: SERVER_INFO.version });
if (!live.disabled) live.start();

serve({ live });
