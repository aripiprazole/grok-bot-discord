// PCM conversion between Discord voice (48 kHz stereo s16le) and ElevenLabs Agents (mono s16le).

export const INPUT_RATE = 16_000; // PCM mono we send to ElevenLabs Agents
export const DISCORD_RATE = 48_000;
export const FRAME_MS = 20;
export const INPUT_FRAME_BYTES = (INPUT_RATE / 1000) * FRAME_MS * 2;

const clamp = (n) => (n > 32767 ? 32767 : n < -32768 ? -32768 : n);

// 48 kHz stereo → 16 kHz mono: average three stereo frames (6 samples → 1).
export function discordToEleven(pcm) {
  const frames = Math.floor(pcm.length / 12);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0, o = 0; o < out.length; i += 12, o += 2) {
    let sum = 0;
    for (let j = 0; j < 12; j += 2) sum += pcm.readInt16LE(i + j);
    out.writeInt16LE(clamp(Math.round(sum / 6)), o);
  }
  return out;
}

// "pcm_16000" → 16000, "ulaw_8000" → 8000, anything else → null.
export function pcmRate(format) {
  if (format === "ulaw_8000") return 8000;
  const match = /^pcm_(\d+)$/.exec(format ?? "");
  return match ? Number(match[1]) : null;
}

// G.711 μ-law byte → PCM. 0xFF is silence.
export function ulawToPcm(ulaw) {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) {
    let u = ~ulaw[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    if (sign) sample = -sample;
    out.writeInt16LE(clamp(sample), i * 2);
  }
  return out;
}

// Linear resample of mono s16le. Exact ratios (16 kHz → 48 kHz) stay in sync.
export function resampleMono(pcm, fromRate, toRate) {
  if (!fromRate || fromRate === toRate) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  if (!inSamples) return Buffer.alloc(0);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const last = inSamples - 1;
  for (let i = 0; i < outSamples; i++) {
    const x = (i * fromRate) / toRate;
    const i0 = Math.min(last, Math.floor(x));
    const i1 = Math.min(last, i0 + 1);
    const frac = x - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(clamp(Math.round(s0 + (s1 - s0) * frac)), i * 2);
  }
  return out;
}

// 48 kHz mono → 48 kHz stereo. Keeps a stray odd byte for the next chunk.
export function createUpmixer() {
  let carry = Buffer.alloc(0);
  return function upmix(chunk) {
    const pcm = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = pcm.length - (pcm.length % 2);
    carry = pcm.subarray(usable);
    const out = Buffer.alloc(usable * 2);
    for (let i = 0; i < usable; i += 2) {
      const s = pcm.readInt16LE(i);
      out.writeInt16LE(s, i * 2);
      out.writeInt16LE(s, i * 2 + 2);
    }
    return out;
  };
}

// Sums equal-length mono frames with clipping.
export function mix(frames) {
  if (frames.length === 1) return frames[0];
  const out = Buffer.alloc(frames[0].length);
  for (let i = 0; i < out.length; i += 2) {
    let sum = 0;
    for (const f of frames) sum += f.readInt16LE(i);
    out.writeInt16LE(clamp(sum), i);
  }
  return out;
}

/**
 * Per-speaker queues of fixed-size mono frames. Discord delivers each person's audio
 * separately and in bursts; next() takes one frame from everyone talking and mixes them.
 */
export class Mixer {
  constructor({ frameBytes = INPUT_FRAME_BYTES, maxQueuedFrames = 50 } = {}) {
    this.frameBytes = frameBytes;
    this.maxQueuedFrames = maxQueuedFrames;
    this.queues = new Map();
    this.partial = new Map();
  }

  push(speakerId, pcm) {
    const data = this.partial.has(speakerId) ? Buffer.concat([this.partial.get(speakerId), pcm]) : pcm;
    const queue = this.queues.get(speakerId) ?? [];
    let offset = 0;
    for (; offset + this.frameBytes <= data.length; offset += this.frameBytes) queue.push(data.subarray(offset, offset + this.frameBytes));
    // Bound latency: if someone's audio piles up, drop their oldest frames.
    if (queue.length > this.maxQueuedFrames) queue.splice(0, queue.length - this.maxQueuedFrames);
    this.queues.set(speakerId, queue);
    if (offset < data.length) this.partial.set(speakerId, data.subarray(offset));
    else this.partial.delete(speakerId);
  }

  remove(speakerId) {
    this.queues.delete(speakerId);
    this.partial.delete(speakerId);
  }

  next() {
    const frames = [];
    for (const queue of this.queues.values()) if (queue.length) frames.push(queue.shift());
    return frames.length ? mix(frames) : null;
  }
}
