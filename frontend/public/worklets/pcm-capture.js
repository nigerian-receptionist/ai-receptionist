/**
 * Mic capture worklet: downsamples the input stream to 16 kHz mono s16le and
 * posts 20 ms frames (320 samples) to the main thread as transferable buffers.
 * Loaded from /worklets/pcm-capture.js (same origin, no CDN).
 *
 * Resampling (AGENTS.md 5.5): naive decimation would fold high-frequency
 * noise into the 0-8 kHz band and hurt STT, so each output sample is a
 * windowed-sinc FIR low-pass (65 taps, Hamming window, ~7 kHz cutoff)
 * evaluated at the fractional input position, with the filter designed at
 * runtime for the actual device sample rate. Linear phase; group delay is
 * 32 input samples (<1 ms), negligible for VAD/STT timing.
 *
 * Buffering: one preallocated Float32Array compacted with copyWithin, so the
 * hot path allocates only the posted frame (no per-callback copy+slice).
 */

/** Design a unity-DC-gain low-pass FIR (windowed sinc, Hamming window). */
function designLowpass(sampleRate, cutoffHz, numTaps) {
  const taps = new Float64Array(numTaps);
  const middle = (numTaps - 1) / 2;
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  let sum = 0;
  for (let n = 0; n < numTaps; n += 1) {
    const x = n - middle;
    const sinc = x === 0 ? 1 : Math.sin(omega * x) / (omega * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (numTaps - 1));
    taps[n] = (omega / Math.PI) * sinc * window;
    sum += taps[n];
  }
  for (let n = 0; n < numTaps; n += 1) taps[n] /= sum;
  return taps;
}

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameOut = 320;
    this.ratio = sampleRate / 16000;
    this.taps = designLowpass(sampleRate, 7000, 65);
    this.margin = (this.taps.length - 1) / 2;
    this.frameIn = Math.floor(this.frameOut * this.ratio);
    // History retained across frames so every output has full filter memory.
    this.retain = this.taps.length - 1;
    // Two input frames plus filter overhang; steady state never grows this.
    this.buf = new Float32Array(this.frameIn * 2 + this.taps.length * 2);
    this.len = 0;
    // Index in buf where the current input frame starts (history before it).
    this.start = 0;
  }

  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.append(channel);
    // centres 0..frameIn plus filter lookahead, offset by retained history
    // (recomputed per frame: `start` advances after each emission).
    while (this.len >= this.start + this.frameIn + this.taps.length) {
      const out = new Int16Array(this.frameOut);
      for (let i = 0; i < this.frameOut; i += 1) {
        // Fractional position with linear interpolation between the two
        // neighbouring integer-centred convolutions (nearest-centre picking
        // would reintroduce imaging artefacts at the output rate).
        const exact = i * this.ratio;
        const base = this.start + Math.floor(exact);
        const frac = exact - Math.floor(exact);
        let low = 0;
        let high = 0;
        for (let k = 0; k < this.taps.length; k += 1) {
          const tap = this.taps[k];
          const lowIdx = base + k - this.margin;
          const highIdx = lowIdx + 1;
          low += tap * (lowIdx < 0 || lowIdx >= this.len ? 0 : this.buf[lowIdx]);
          high += tap * (highIdx < 0 || highIdx >= this.len ? 0 : this.buf[highIdx]);
        }
        const clamped = Math.max(-1, Math.min(1, low + (high - low) * frac));
        out[i] = Math.round(clamped * 32767);
      }
      this.port.postMessage(out.buffer, [out.buffer]);
      // Drop the consumed frame but keep `retain` history samples for the
      // next frame's filter memory (zero history only at stream start).
      const nextStart = this.start + this.frameIn;
      const keepFrom = Math.max(0, nextStart - this.retain);
      this.buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      this.start = nextStart - keepFrom;
    }
    return true;
  }

  append(channel) {
    if (this.len + channel.length > this.buf.length) {
      const grown = new Float32Array((this.len + channel.length) * 2);
      grown.set(this.buf.subarray(0, this.len), 0);
      this.buf = grown;
    }
    this.buf.set(channel, this.len);
    this.len += channel.length;
  }
}

registerProcessor("pcm-capture", PcmCapture);
