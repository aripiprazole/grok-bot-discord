// PCM conversion between Discord voice (48 kHz stereo s16le) and Grok realtime (mono s16le).

export const INPUT_RATE = 24_000; // what we send to Grok
export const OUTPUT_RATE = 48_000; // what we ask Grok to send back (Discord's native rate)
export const FRAME_MS = 20;
export const INPUT_FRAME_BYTES = (INPUT_RATE / 1000) * FRAME_MS * 2;

const clamp = (n) => (n > 32767 ? 32767 : n < -32768 ? -32768 : n);

// 48 kHz stereo → 24 kHz mono: average each pair of stereo frames (4 samples → 1).
export function discordToGrok(pcm) {
  const out = Buffer.alloc(Math.floor(pcm.length / 8) * 2);
  for (let i = 0, o = 0; o < out.length; i += 8, o += 2) {
    const sum = pcm.readInt16LE(i) + pcm.readInt16LE(i + 2) + pcm.readInt16LE(i + 4) + pcm.readInt16LE(i + 6);
    out.writeInt16LE(Math.round(sum / 4), o);
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
