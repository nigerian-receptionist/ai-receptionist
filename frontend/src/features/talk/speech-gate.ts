/**
 * Client-side speech-event gate between the Silero VAD callbacks and the
 * `input.speech_started` / `input.speech_ended` wire messages.
 *
 * M10: short VAD blips must never start a phantom agent turn. The hook waits
 * for `onSpeechRealStart` (VAD-confirmed speech of at least `minSpeechMs`)
 * and maps it to `real-start` here; `onVADMisfire` maps to `misfire` and
 * sends nothing unless a turn was already opened (defensive: that ordering
 * cannot happen with the current VAD, but keeps client/server in sync).
 *
 * M14: while agent audio is playing, the hook raises the VAD bar through
 * `MicVAD.setOptions` (higher positive threshold + longer `minSpeechMs`,
 * per AGENTS.md 10.3: 2 words or 300 ms to interrupt) and keeps relying on
 * the mic stream's `echoCancellation`. The longer confirmation delay is the
 * barge-in cost of self-trigger suppression.
 *
 * Pure state machine; time lives in the VAD, timers live in the hook.
 */

export type VadSignal = "real-start" | "end" | "misfire";

/** Wire-level actions the hook must take, in order. */
export type SpeechAction = "started" | "ended";

/** Min confirmed speech before a turn opens while the agent is silent. */
export const IDLE_MIN_SPEECH_MS = 250;

/** Min confirmed speech before barge-in while agent audio is playing. */
export const PLAYING_MIN_SPEECH_MS = 500;

/** Silero positive threshold while the agent is silent (vad-web default). */
export const IDLE_POSITIVE_THRESHOLD = 0.3;

/** Raised Silero positive threshold while agent audio is playing. */
export const PLAYING_POSITIVE_THRESHOLD = 0.55;

export class SpeechGate {
  private speaking = false;

  handle(signal: VadSignal): SpeechAction[] {
    switch (signal) {
      case "real-start":
        if (this.speaking) return [];
        this.speaking = true;
        return ["started"];
      case "end":
        if (!this.speaking) return [];
        this.speaking = false;
        return ["ended"];
      case "misfire":
        // No turn was opened: stay silent. If one was (unexpected VAD
        // ordering), close it so the server does not wait forever.
        if (!this.speaking) return [];
        this.speaking = false;
        return ["ended"];
    }
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }
}

/**
 * Clamp the endpointing silence knob (ms of trailing silence before a turn
 * ends). Guards the `NEXT_PUBLIC_ENDPOINTING_SILENCE_MS` env parsing against
 * NaN/zero/negative/absurd values.
 */
export function clampEndpointingSilenceMs(raw: unknown, fallback = 600): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(2000, Math.max(200, Math.round(value)));
}
