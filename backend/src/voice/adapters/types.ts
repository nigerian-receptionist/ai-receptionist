/**
 * Adapter interfaces for the voice loop. TypeScript versions of AGENTS.md 5.4.
 *
 * Core code (gateway, session) imports these interfaces only, never the vendor
 * modules under `stt/`, `tts/` or `llm/`. Every vendor implementation must:
 *   - load/connect once and stay warm; never connect inside a turn,
 *   - take device/model/version from config, never hard-code them,
 *   - always return timing fields (a missing timing field is a bug),
 *   - bound every outbound call with a timeout.
 */

/** Word-level timing, seconds relative to the audio it was recognised from. */
export interface WordTiming {
  text: string;
  startS: number;
  endS: number;
  confidence: number | null;
}

export interface SttResult {
  text: string;
  /** BCP-47-ish code used on the wire, e.g. "en". */
  language: string;
  confidence: number | null;
  words: WordTiming[];
  audioS: number;
  latencyS: number;
  /** e.g. "stt_cartesia@ink-2". */
  modelId: string;
}

export type SttEvent = { kind: "partial"; text: string } | { kind: "final"; result: SttResult };

/**
 * One live streaming recognition session (one caller turn series on one
 * connection). Audio is pushed in as it arrives; `finalize()` resolves with
 * the transcript for everything pushed since the previous finalize.
 */
export interface SttStreamSession {
  /** Push 16-bit PCM mono audio at the session sample rate. */
  sendAudio(pcmS16le: Buffer): void;
  /** End the current utterance and resolve with its final transcript. */
  finalize(): Promise<SttResult>;
  /**
   * Abandon the in-flight finalize (if any) and clear buffered transcript
   * and audio accounting, so the next turn starts clean (M1 barge-in during
   * the finalize wait). The abandoned finalize rejects.
   */
  reset(): void;
  /** Register a listener for partial/final events (at most one listener). */
  onEvent(listener: (event: SttEvent) => void): void;
  close(): Promise<void>;
}

export interface SpeechToText {
  readonly modelId: string;
  startSession(opts: {
    sampleRate: number;
    language?: string;
    /** STT keyterms (bias phrases); set once per connection, never caller data. */
    keyterms?: string[];
  }): Promise<SttStreamSession>;
}

export interface VoiceInfo {
  voiceId: string;
  language: string;
  gender: string;
  tones: string[];
}

export interface AudioChunk {
  pcmS16le: Buffer;
  sampleRate: number;
  isFirst: boolean;
  isLast: boolean;
}

export interface TtsResult {
  pcmS16le: Buffer;
  sampleRate: number;
  durationS: number;
  timeToFirstAudioS: number;
  totalLatencyS: number;
  voiceId: string;
  modelId: string;
  /** Text after normalisation, i.e. what was actually spoken. */
  textSpoken: string;
  words: WordTiming[];
}

export type TtsStreamEvent =
  | { kind: "audio"; chunk: AudioChunk }
  | { kind: "timestamps"; words: WordTiming[] }
  | { kind: "done"; result: TtsResult };

/**
 * One agent reply synthesised on one Cartesia context (continuations): each
 * sentence is pushed as it completes (`continue: true`, joining spaces so the
 * concatenated transcript is valid) and the reply ends with `finish()` (empty
 * transcript, `continue: false`). Audio streams back in push order with word
 * timestamps, and a single `done` closes the context. All fields except
 * transcript/continue stay identical within the context.
 */
export interface TtsReplyStream {
  /**
   * Push one sentence (verbatim; the caller owns joining spaces). A no-op
   * after abort; throws after `finish()`.
   */
  push(text: string): void;
  /** End the reply. Idempotent; throws when nothing was pushed. */
  finish(): void;
  /**
   * Audio/timestamp events in push order. Rejects on abort or error; queued
   * audio is dropped on abort so a cancelled reply never leaks stale chunks.
   */
  events(): AsyncIterable<TtsStreamEvent>;
}

/**
 * One warm TTS connection for a voice session. Replies multiplex on it by
 * context id; each reply is independently cancellable via its AbortSignal.
 */
export interface TtsStreamSession {
  speakReply(opts: {
    voiceId: string;
    language: string;
    /** Session tone name (adapter maps it to a Cartesia emotion). */
    tone?: string;
    speed?: number;
    contextId: string;
    signal?: AbortSignal;
  }): TtsReplyStream;
  close(): Promise<void>;
}

export interface TextToSpeech {
  readonly modelId: string;
  voices(): VoiceInfo[];
  /**
   * One-shot synthesis (used for pre-rendered blocks). Implementations may use
   * a REST endpoint; streaming sessions use `startSession()`.
   */
  synthesize(
    text: string,
    opts: {
      voiceId: string;
      language: string;
      tone?: string;
      speed?: number;
      /** Requested output rate; implementations report the actual rate. */
      sampleRate?: number;
      signal?: AbortSignal;
    },
  ): Promise<TtsResult>;
  startSession(opts: { sampleRate: number }): Promise<TtsStreamSession>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  in: number | null;
  out: number | null;
  reasoning: number | null;
}

export type LlmEvent = { kind: "delta"; text: string } | { kind: "usage"; usage: TokenUsage };

export interface LlmClient {
  readonly model: string;
  streamChat(
    messages: ChatMessage[],
    opts: { signal?: AbortSignal; maxTokens?: number },
  ): AsyncIterable<LlmEvent>;
}
