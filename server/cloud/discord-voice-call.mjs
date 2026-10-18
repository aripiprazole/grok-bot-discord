// Joins a Discord voice channel from the voice host. The adapter is registered synchronously
// so gateway packets can arrive before the speech-to-text check finishes.

import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { bindVoiceToConnection } from "../live/voice/call.mjs";

const CONNECT_TIMEOUT_MS = 20_000;

export function startDiscordCall(spec, hooks, deps = {}) {
  const join = deps.joinVoiceChannel ?? joinVoiceChannel;
  const enters = deps.entersState ?? entersState;
  const Status = deps.VoiceConnectionStatus ?? VoiceConnectionStatus;
  const bind = deps.bind ?? bindVoiceToConnection;
  const pending = [];
  let methods = null;
  let stopped = false;
  let binder = null;

  function deliver(packet) {
    if (!methods) {
      pending.push(packet);
      return;
    }
    const data = packet.d ?? {};
    if (packet.t === "VOICE_SERVER_UPDATE" && data.guild_id === spec.guildId) methods.onVoiceServerUpdate(data);
    else if (packet.t === "VOICE_STATE_UPDATE" && data.user_id === spec.userId && data.guild_id === spec.guildId) methods.onVoiceStateUpdate(data);
  }

  const adapterCreator = (next) => {
    methods = next;
    for (const packet of pending.splice(0)) deliver(packet);
    return {
      sendPayload(payload) {
        hooks.sendPayload?.(payload);
        return true;
      },
      destroy() {
        methods = null;
      },
    };
  };

  const connection = join({
    channelId: spec.channelId,
    guildId: spec.guildId,
    adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  const session = {
    feed(packet) {
      if (!stopped && packet) deliver(packet);
    },
    say(content, opts) {
      if (!binder) throw new Error("The voice call isn't connected yet.");
      return binder.say(content, opts);
    },
    stop(reason) {
      if (stopped) return;
      stopped = true;
      binder?.stop();
      try {
        connection?.destroy();
      } catch {
        // already destroyed
      }
      hooks.onEnded?.(reason ?? null);
    },
    ready: null,
  };

  try {
    binder = bind(connection, {
      apiKey: spec.elevenApiKey,
      voiceId: spec.voiceId || null,
      ttsModel: spec.ttsModel || undefined,
      language: spec.language || null,
      // Never transcribe ourselves.
      canHear: (userId) => userId !== spec.userId && (spec.listen !== "me" || userId === spec.hostId),
      maxMinutes: spec.maxMinutes ?? 60,
      onUtterance: (u) => hooks.onUtterance?.(u),
      onSpoken: (text) => hooks.onTranscript?.(text),
      onError: (err) => hooks.onStatus?.(`error: ${err.message}`),
      onLimit: (reason) => session.stop(reason),
      log: hooks.log ?? console,
    });
  } catch (err) {
    session.stop(err.message);
    session.ready = Promise.resolve();
    return session;
  }

  session.ready = Promise.all([enters(connection, Status.Ready, CONNECT_TIMEOUT_MS), binder.ready])
    .then(() => {
      if (stopped) return;
      connection.on?.(Status.Disconnected, async () => {
        try {
          await Promise.race([enters(connection, Status.Signalling, 5_000), enters(connection, Status.Connecting, 5_000)]);
        } catch {
          session.stop("Disconnected from the voice channel.");
        }
      });
      hooks.onStatus?.("ready");
    })
    .catch((err) => {
      if (!stopped) session.stop(err.message);
    });

  return session;
}
