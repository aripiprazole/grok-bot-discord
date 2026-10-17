// Moves audio between a voice call and a Grok realtime session. Discord- and socket-free so it can be
// tested: the caller supplies `send` (realtime client events) and the playback/transcript callbacks.

import { FRAME_MS, INPUT_FRAME_BYTES, INPUT_RATE, Mixer, OUTPUT_RATE, discordToGrok } from "./audio.mjs";

// Keep sending silence briefly after people stop talking so server VAD can detect the end of a turn.
const TRAILING_SILENCE_MS = 1_200;
const SEND_EVERY_FRAMES = 5; // batch 100 ms of audio per message

export function sessionConfig({ voice, instructions, tools = [] }) {
  return {
    voice,
    instructions,
    turn_detection: { type: "server_vad" },
    audio: {
      input: { format: { type: "audio/pcm", rate: INPUT_RATE } },
      output: { format: { type: "audio/pcm", rate: OUTPUT_RATE } },
    },
    ...(tools.length ? { tools: tools.map((type) => ({ type })) } : {}),
  };
}

export class VoiceBridge {
  constructor({ send, onAudio, onInterrupt, onResponseDone, onTranscript, onError, now = () => performance.now() }) {
    Object.assign(this, { send, onAudio, onInterrupt, onResponseDone, onTranscript, onError, now });
    this.mixer = new Mixer();
    this.pending = [];
    this.startedAt = null;
    this.framesDue = 0;
    this.lastVoiceAt = -Infinity;
  }

  // Decoded Discord audio (48 kHz stereo) from one person.
  pushUserAudio(speakerId, pcm) {
    this.mixer.push(speakerId, discordToGrok(pcm));
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
    this.send({ type: "input_audio_buffer.append", audio });
  }

  handleEvent(event) {
    switch (event.type) {
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.onAudio(Buffer.from(event.delta, "base64"));
        break;
      case "input_audio_buffer.speech_started":
        // Barge-in: someone started talking, so drop any reply audio still queued.
        this.onInterrupt();
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const text = event.transcript ?? event.text;
        if (text?.trim()) this.onTranscript(text.trim());
        break;
      }
      case "response.done":
        this.onResponseDone();
        break;
      case "error":
        this.onError(new Error(event.error?.message ?? JSON.stringify(event.error ?? event)));
        break;
    }
  }
}
