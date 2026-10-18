// Binds one Discord voice connection to an ElevenLabs Agents session.
// Shared by the local daemon and the Cloudflare voice container.

import { PassThrough } from "node:stream";
import { EndBehaviorType, NoSubscriberBehavior, StreamType, createAudioPlayer, createAudioResource } from "@discordjs/voice";
import prism from "prism-media";
import { DISCORD_RATE, FRAME_MS, createUpmixer, pcmRate, resampleMono, ulawToPcm } from "./audio.mjs";
import { VoiceBridge } from "./bridge.mjs";
import { ensureElevenAgent } from "./eleven-agent.mjs";
import { connectEleven } from "./eleven.mjs";
import { ASK_AGENT_RESULT, ASK_AGENT_TOOL_NAME, speakRequest, toolResult } from "./prompt.mjs";

const SPEAKER_SILENCE_MS = 1_000;
const PREBUFFER_BYTES = DISCORD_RATE * 2 * 2 * 0.2;
const MAX_MISSED_FRAMES = 250;

export function bindElevenToConnection(connection, opts) {
  const {
    apiKey,
    agentId = null,
    voiceId = null,
    instructions,
    canHear = () => true,
    onTranscript = () => {},
    onError = () => {},
    onAgentRequest = () => {},
    onClose = () => {},
    onLimit = () => {},
    callInfo = null,
    maxMinutes = 60,
    fetchImpl,
    log = console,
  } = opts;

  const upmix = createUpmixer();
  let outputFormat = "pcm_16000";
  let out = null;
  let prebuffer = [];
  let prebufferBytes = 0;
  let stopped = false;
  let live = false;
  let realtime = null;
  const streams = new Map();

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES } });
  player.on("error", (err) => log.warn?.(`Voice playback: ${err.message}`));
  connection.subscribe(player);

  function play(pcm) {
    const stereo = upmix(pcm);
    if (!stereo.length) return;
    if (out) {
      out.write(stereo);
      return;
    }
    prebuffer.push(stereo);
    prebufferBytes += stereo.length;
    if (prebufferBytes >= PREBUFFER_BYTES) startReply();
  }

  function startReply() {
    out = new PassThrough();
    for (const chunk of prebuffer) out.write(chunk);
    prebuffer = [];
    prebufferBytes = 0;
    player.play(createAudioResource(out, { inputType: StreamType.Raw }));
  }

  function endReply() {
    if (!out && prebufferBytes) startReply();
    out?.end();
    out = null;
  }

  function interrupt() {
    prebuffer = [];
    prebufferBytes = 0;
    out?.destroy();
    out = null;
    player.stop(true);
  }

  function playback(buf) {
    const pcm = String(outputFormat).startsWith("ulaw") ? ulawToPcm(buf) : buf;
    const rate = pcmRate(outputFormat) ?? DISCORD_RATE;
    play(resampleMono(pcm, rate, DISCORD_RATE));
  }

  const bridge = new VoiceBridge({
    send: (event) => realtime?.send(event),
    onAudio: playback,
    onInterrupt: interrupt,
    onResponseDone: endReply,
    onTranscript,
    onError,
    onFunctionCall: (call) => onTool(call),
  });

  function onTool(call) {
    const reply = (result, isError = false) => realtime?.send(toolResult(call.callId, result, isError));
    if (call.name !== ASK_AGENT_TOOL_NAME) {
      reply(`Unknown tool: ${call.name}`, true);
      return;
    }
    const request = String(call.arguments?.request ?? "").trim();
    if (!request) {
      reply("request is required.", true);
      return;
    }
    reply(ASK_AGENT_RESULT, false);
    Promise.resolve()
      .then(() => onAgentRequest({ request, call: callInfo }))
      .catch((err) => log.warn?.(`Voice handoff failed: ${err.message}`));
  }

  function hear(userId) {
    if (stopped || streams.has(userId) || !canHear(userId)) return;
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SPEAKER_SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: DISCORD_RATE, channels: 2, frameSize: 960 });
    streams.set(userId, opus);
    const cleanup = () => {
      if (streams.get(userId) === opus) streams.delete(userId);
      bridge.removeSpeaker(userId);
      decoder.destroy();
    };
    opus.once("end", cleanup).once("close", cleanup);
    opus.on("error", (err) => log.warn?.(`Voice receive (${userId}): ${err.message}`));
    decoder.on("error", (err) => log.warn?.(`Opus decode (${userId}): ${err.message}`));
    opus.pipe(decoder).on("data", (pcm) => bridge.pushUserAudio(userId, pcm));
  }

  connection.receiver.speaking.on("start", (userId) => hear(userId));
  const ticker = setInterval(() => bridge.tick(), FRAME_MS);
  ticker.unref?.();
  const limit = setTimeout(() => onLimit(`Hit the ${maxMinutes}-minute voice limit. Run /join to start again.`), maxMinutes * 60_000);
  limit.unref?.();

  const ready = (async () => {
    const ensured = await ensureElevenAgent({ apiKey, agentId, voiceId, fetchImpl });
    realtime = connectEleven({
      apiKey,
      agentId: ensured.agentId,
      voiceId,
      instructions,
      fetchImpl,
      onEvent: (event) => {
        if (event.type === "conversation_initiation_metadata") {
          const meta = event.conversation_initiation_metadata_event ?? {};
          if (meta.agent_output_audio_format) outputFormat = meta.agent_output_audio_format;
        }
        bridge.handleEvent(event);
      },
      onClose: (code, reason) => {
        if (!live || stopped) return;
        onClose(code, reason);
      },
    });
    await realtime.ready;
    live = true;
    return ensured;
  })();
  ready.catch(() => {});

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    clearTimeout(limit);
    realtime?.close();
    for (const stream of streams.values()) stream.destroy();
    streams.clear();
    out?.destroy();
    player.stop(true);
  }

  return {
    ready,
    say(text) {
      const content = String(text ?? "").trim();
      if (!content) throw new Error("content must be a non-empty string.");
      if (!live) throw new Error("The voice call isn't connected to ElevenLabs yet.");
      realtime.send(speakRequest(content));
    },
    stop,
  };
}
