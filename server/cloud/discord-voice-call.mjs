// Joins a Discord voice channel from the container. The adapter is registered synchronously
// so gateway packets can arrive before ElevenLabs provisioning finishes.

import { VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { bindElevenToConnection } from "../live/voice/eleven-call.mjs";

const CONNECT_TIMEOUT_MS = 20_000;

export function startDiscordCall(spec, hooks, deps = {}) {
  const join = deps.joinVoiceChannel ?? joinVoiceChannel;
  const enters = deps.entersState ?? entersState;
  const Status = deps.VoiceConnectionStatus ?? VoiceConnectionStatus;
  const bind = deps.bind ?? bindElevenToConnection;
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
    say(content) {
      if (!binder) throw new Error("The voice call isn't connected to ElevenLabs yet.");
      return binder.say(content);
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
      agentId: spec.agentId || null,
      voiceId: spec.voiceId || null,
      instructions: spec.instructions,
      canHear: (userId) => spec.listen !== "me" || userId === spec.hostId,
      callInfo: {
        guildId: spec.guildId,
        channelId: spec.channelId,
        place: spec.place,
        listen: spec.listen,
        hostId: spec.hostId ?? null,
      },
      maxMinutes: spec.maxMinutes ?? 60,
      onTranscript: (text) => hooks.onTranscript?.(text),
      onError: (err) => hooks.onStatus?.(`error: ${err.message}`),
      onAgentRequest: (payload) => hooks.onAgentRequest?.(payload),
      onClose: (code, reason) => session.stop(code === 1000 ? null : `ElevenLabs disconnected (${code}${reason ? `: ${reason}` : ""}).`),
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
