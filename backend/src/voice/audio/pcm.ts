/**
 * Tiny PCM helpers: linear-interpolation resampling and duration maths.
 *
 * NOTE: linear interpolation has no anti-alias low-pass filter, so this is
 * NOT AGENTS.md 5.5-grade resampling. It is used only by the voice-smoke
 * script (test audio prep). Keep it off the live path; telephony needs
 * sox/soxr-quality resampling.
 */

/** Resample mono s16le PCM with linear interpolation (fine for speech). */
export function resamplePcmS16le(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error("pcm sample rates must be positive");
  }
  if (input.length === 0) return Buffer.alloc(0);
  if (input.length % 2 !== 0) throw new Error("pcm input must be even-length");
  if (fromRate === toRate) return Buffer.from(input);
  const inSamples = input.length / 2;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const output = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const position = (i * (inSamples - 1)) / Math.max(1, outSamples - 1);
    const index = Math.floor(position);
    const frac = position - index;
    const a = input.readInt16LE(index * 2);
    const b = index + 1 < inSamples ? input.readInt16LE((index + 1) * 2) : a;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))), i * 2);
  }
  return output;
}

/** Duration in seconds of mono s16le PCM at `sampleRate`. */
export function pcmDurationS(byteLength: number, sampleRate: number): number {
  return byteLength / 2 / sampleRate;
}
