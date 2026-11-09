/**
 * WebSocket protocol between the browser (frontend /talk) and the NestJS voice gateway.
 *
 * SOURCE OF TRUTH. Copy this file verbatim to:
 *   backend/src/voice/protocol.ts
 *   frontend/src/features/talk/protocol.ts
 * Change it here first, then re-copy. A unit test in each package asserts the copy matches.
 *
 * Endpoint: ws://127.0.0.1:8000/v1/voice?token=<DEV_ACCESS_TOKEN>
 *   - The server rejects the upgrade unless Origin is in ALLOWED_ORIGINS and the token matches.
 *   - Text frames carry JSON messages below. Binary frames carry audio.
 *
 * Audio:
 *   - Client -> server binary frames: mic audio, PCM s16le, mono, 16 kHz, 20 to 100 ms per frame.
 *     Frames received before the server sends `state` = "listening" are dropped.
 *   - Server -> client audio: JSON `agent.audio` messages with base64 PCM s16le mono at
 *     `session.ready.outputSampleRate` (24 kHz), tagged with utteranceId so stale audio can be dropped.
 *
 * Turn taking:
 *   - The client runs voice activity detection (Silero via @ricky0123/vad-web) and sends
 *     `input.speech_started` / `input.speech_ended`. On speech_ended the server finalises STT and
 *     starts the agent turn. The server also accepts STT-side finals as a fallback.
 *   - Barge-in: if the user starts speaking while agent audio plays, the client stops playback at
 *     once and sends `input.speech_started` + `playback.interrupted` with how much it played.
 *     The server cancels LLM and TTS and truncates the agent turn in history to what was heard.
 */

export const VOICE_PROTOCOL_VERSION = 1;

export type AgentState = "connecting" | "notice" | "listening" | "thinking" | "speaking" | "ended";

// ---------- client -> server ----------

export type ClientMessage =
  | { type: "session.start"; protocolVersion: number; agentId?: string; inputSampleRate: 16000 }
  | { type: "input.speech_started"; atMs: number }
  | { type: "input.speech_ended"; atMs: number }
  /** Client finished playing an utterance (all its audio was heard). */
  | { type: "playback.done"; utteranceId: string }
  /** Client stopped playback early. playedMs is audio actually played for this utterance. */
  | { type: "playback.interrupted"; utteranceId: string; playedMs: number }
  /** Sent periodically (every ~250 ms) while playing, so the server can time playout start. */
  | { type: "playback.progress"; utteranceId: string; playedMs: number }
  | { type: "session.end" };

// ---------- server -> client ----------

export interface TurnTimingsMs {
  /** input.speech_ended -> STT final text available */
  stt: number | null;
  /** STT final -> first LLM token */
  llm_first_token: number | null;
  /** STT final -> LLM stream finished */
  llm_total: number | null;
  /** first sentence sent to TTS -> first audio chunk from TTS */
  tts_first_audio: number | null;
  /** input.speech_ended -> first agent.audio sent to client (the headline latency) */
  end_to_first_audio: number | null;
}

export type ServerMessage =
  | {
      type: "session.ready";
      protocolVersion: number;
      sessionId: string;
      interactionId: string;
      outputSampleRate: number;
      voiceId: string;
      sttModelId: string;
      ttsModelId: string;
      llmModel: string;
    }
  | { type: "state"; state: AgentState }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; turnId: string; text: string }
  /** Streaming agent text. kind "block" = pre-rendered approved audio (disclosure, recording notice). */
  | { type: "agent.text"; utteranceId: string; delta: string; kind: "speech" | "block"; blockId?: string }
  | { type: "agent.audio"; utteranceId: string; seq: number; pcmBase64: string }
  | { type: "agent.audio.end"; utteranceId: string }
  /** Sent when the server cancelled an utterance (barge-in); client drops queued audio for it. */
  | { type: "agent.cancelled"; utteranceId: string }
  | { type: "turn.metrics"; turnId: string; timingsMs: TurnTimingsMs }
  | { type: "error"; code: VoiceErrorCode; message: string; fatal: boolean };

export type VoiceErrorCode =
  | "bad_message"
  | "unsupported_version"
  | "stt_failed"
  | "llm_failed"
  | "tts_failed"
  | "internal";
