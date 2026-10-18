// Moves audio between a Discord voice call and an ElevenLabs Agents session.
// Discord- and socket-free so it can be tested: the caller supplies `send` and the playback callbacks.

import { FRAME_MS, INPUT_FRAME_BYTES, Mixer, discordToEleven } from "./audio.mjs";

// Keep sending silence briefly after people stop talking so ElevenLabs can close the turn.
const TRAILING_SILENCE_MS = 1_200;
const SEND_EVERY_FRAMES = 5; // batch 100 ms of audio per message

export class VoiceBridge {
  constructor({ send, onAudio, onInterrupt, onResponseDone, onTranscript, onError, onFunctionCall, now = () => performance.now() }) {
    Object.assign(this, { send, onAudio, onInterrupt, onResponseDone, onTranscript, onError, onFunctionCall, now });
    this.mixer = new Mixer();
    this.pending = [];
    this.startedAt = null;
    this.framesDue = 0;
    this.lastVoiceAt = -Infinity;
    this.seenCalls = new Set();
  }

  // Decoded Discord audio (48 kHz stereo) from one person.
  pushUserAudio(speakerId, pcm) {
    this.mixer.push(speakerId, discordToEleven(pcm));
  }

  removeSpeaker(speakerId) {
    this.mixer.remove(speakerId);
  }

  // Call every ~20 ms. Emits as many frames as wall-clock time says are due.
  tick() {
    const now = this.now();
    this.startedAt ??= now;
    const due = Math.floor((now - this.startedAt) / FRAME_MS);
    for (; this.framesDue < due; this.framesDue++) {
      const frame = this.mixer.next();
      if (frame) {
        this.lastVoiceAt = now;
        this.pending.push(frame);
      } else if (now - this.lastVoiceAt < TRAILING_SILENCE_MS) {
        this.pending.push(Buffer.alloc(INPUT_FRAME_BYTES));
      } else {
        this.flush();
      }
      if (this.pending.length >= SEND_EVERY_FRAMES) this.flush();
    }
  }

  flush() {
    if (!this.pending.length) return;
    const audio = Buffer.concat(this.pending).toString("base64");
    this.pending = [];
    this.send({ user_audio_chunk: audio });
  }

  handleEvent(event) {
    switch (event.type) {
      case "audio": {
        const b64 = event.audio_event?.audio_base_64;
        if (b64) this.onAudio(Buffer.from(b64, "base64"));
        if (event.audio_event?.is_final) this.onResponseDone();
        break;
      }
      case "interruption":
        this.onInterrupt();
        break;
      case "agent_response": {
        const text = event.agent_response_event?.agent_response;
        if (text?.trim()) this.onTranscript(text.trim());
        break;
      }
      case "agent_response_correction": {
        const text = event.agent_response_correction_event?.corrected_agent_response;
        if (text?.trim()) this.onTranscript(text.trim());
        break;
      }
      case "agent_response_complete":
        this.onResponseDone();
        break;
      case "ping":
        // Answer immediately. A delayed pong is only for measuring RTT, and a dropped timer would hang up the call.
        this.send({ type: "pong", event_id: event.ping_event?.event_id });
        break;
      case "client_tool_call": {
        const call = event.client_tool_call;
        if (!call?.tool_call_id || this.seenCalls.has(call.tool_call_id)) break;
        this.seenCalls.add(call.tool_call_id);
        this.onFunctionCall?.({
          name: call.tool_name,
          callId: call.tool_call_id,
          arguments: call.parameters ?? {},
        });
        break;
      }
      case "error":
      case "client_error":
        this.onError(new Error(event.error?.message ?? event.message ?? event.client_error_event?.message ?? "ElevenLabs error"));
        break;
      default:
        break;
    }
  }
}
