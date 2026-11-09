/**
 * Mic capture worklet: downsamples the input stream to 16 kHz mono s16le and
 * posts 20 ms frames (320 samples) to the main thread as transferable buffers.
 * Loaded from /worklets/pcm-capture.js (same origin, no CDN).
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
  }

  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      const merged = new Float32Array(this.pending.length + channel.length);
      merged.set(this.pending, 0);
      merged.set(channel, this.pending.length);
      this.pending = merged;
    }
    const ratio = sampleRate / 16000;
    const frameIn = Math.floor(320 * ratio);
    while (this.pending.length >= frameIn) {
      const out = new Int16Array(320);
      for (let i = 0; i < 320; i += 1) {
        const sample = this.pending[Math.floor(i * ratio)] || 0;
        const clamped = Math.max(-1, Math.min(1, sample));
        out[i] = Math.round(clamped * 32767);
      }
      this.port.postMessage(out.buffer, [out.buffer]);
      this.pending = this.pending.slice(frameIn);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
