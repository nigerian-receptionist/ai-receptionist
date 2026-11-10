import { randomUUID } from "node:crypto";

import type { InteractionStore } from "../interactions/interaction-store";
import type {
  ChatMessage,
  LlmClient,
  SpeechToText,
  SttStreamSession,
  TextToSpeech,
  TtsStreamSession,
  WordTiming,
} from "./adapters/types";
import {
  DISCLOSE_AI_BLOCK,
  HOLD_BLOCK,
  RECORDING_NOTICE_BLOCK,
  SILENCE_PROMPT_BLOCK,
  type BlockRenderer,
  type RenderedBlock,
} from "./blocks/block-cache";
import type { ClientMessage } from "./client-messages";
import { normaliseForSpeech } from "./normalise";
import type { AgentState, ServerMessage, TurnTimingsMs } from "./protocol";
import { applySpeakPolicy } from "./speak-policy";
import { VOICE_PROTOCOL_VERSION } from "./protocol";
import { buildSystemPrompt, VOICE_SYSTEM_PROMPT_VERSION } from "./prompts/system";
import { SentenceChunker } from "./sentence-chunker";

export interface VoiceSessionConfig {
  defaultVoiceId: string;
  outputSampleRate: number;
  /** Caller+agent turns of history sent to the LLM. */
  maxHistoryTurns: number;
  silencePromptAfterMs: number;
  silenceEndAfterMs: number;
  noticeAckTimeoutMs: number;
  /** M28: LLM-stall delay before a terminal-complete sentence starts TTS. */
  sentenceIdleFlushMs: number;
  /** F4 cost caps (env VOICE_MAX_*): agent turns, turn audio, session length. */
  maxTurns: number;
  maxTurnAudioS: number;
  maxSessionS: number;
  /** Inbound audio budget per 1s window (nominal 16 kHz s16 mono is 32000). */
  maxBytesPerSec: number;
  /** Caller transcript chars sent to the LLM (the full text is still stored). */
  maxTranscriptChars: number;
  /** Throwaway prefix-matching LLM request while the notice plays (env LLM_WARMUP_ENABLED). */
  llmWarmupEnabled: boolean;
  /** Play a pre-rendered ack when the first LLM token is slow (env ACK_ENABLED). */
  ackEnabled: boolean;
  /** First-token wait before the ack plays, in ms (env ACK_DELAY_MS). */
  ackDelayMs: number;
}

export const DEFAULT_VOICE_SESSION_CONFIG: VoiceSessionConfig = {
  defaultVoiceId: "",
  outputSampleRate: 24000,
  maxHistoryTurns: 12,
  silencePromptAfterMs: 8000,
  silenceEndAfterMs: 20000,
  noticeAckTimeoutMs: 30000,
  sentenceIdleFlushMs: 120,
  maxTurns: 60,
  maxTurnAudioS: 30,
  maxSessionS: 900,
  maxBytesPerSec: 64000,
  maxTranscriptChars: 2000,
  llmWarmupEnabled: true,
  ackEnabled: true,
  ackDelayMs: 400,
};

export interface VoiceSessionDeps {
  tenantId: string;
  store: InteractionStore;
  stt: SpeechToText;
  tts: TextToSpeech;
  llm: LlmClient;
  blocks: BlockRenderer;
  config: VoiceSessionConfig;
  send: (message: ServerMessage) => void;
  /** Close the transport with a WebSocket close code. */
  close: (code: number, reason: string) => void;
  log: (fields: Record<string, unknown>) => void;
}

interface SentenceAudio {
  /** Normalised (spoken) sentence text. */
  sentence: string;
  audioBytes: number;
  durationS: number;
  words: WordTiming[];
}

interface ActiveUtterance {
  id: string;
  sentences: SentenceAudio[];
  playedMs: number;
  done: boolean;
  /** Monotonic timestamp of the first audio chunk sent, for notice-ack validation (F2). */
  firstSentAtMs: number | null;
}

/**
 * Tolerance for notice-ack plausibility: the client's `playback.done` for a
 * notice block is accepted only if at least (block duration − tolerance) of
 * wall-clock time passed since the first audio chunk was sent.
 */
export const NOTICE_ACK_TOLERANCE_MS = 250;

/**
 * Margin after the sent audio duration before the playback backstop assumes
 * the caller heard the reply (covers network + playout-scheduling slack). If
 * `playback.done` never arrives, the silence window starts then. Sized to fail
 * toward a LATE prompt, never early.
 */
export const PLAYBACK_BACKSTOP_MARGIN_MS = 3000;

/**
 * Throwaway user message for the notice-time LLM warmup. The request is
 * aborted at the first token and never touches history, TTS or storage.
 */
export const LLM_WARMUP_USER_MESSAGE = "Reply with OK.";

/** Caller phrases that object to recording (AGENTS.md 9.1 rule 3, M22). */
const RECORDING_OBJECTION_RE =
  /\b(don't|do not|stop|please stop)\s+record(ing)?\b|\bno\s+recording\b|\b(stop|turn off)\s+(the\s+)?recording\b/i;

/** Defensive cap on tracked utterances; oldest done entries are evicted first. */
const MAX_TRACKED_UTTERANCES = 100;

/** Nominal inbound rate: 16 kHz s16 mono. */
const INPUT_BYTES_PER_SEC = 32000;

/** Sustained flood cutoff, as a multiple of one second of byte budget. */
const FLOOD_CUTOFF_WINDOWS = 3;

/**
 * One voice conversation. Owns the AgentState machine, the turn loop, barge-in
 * and the notice handshake. Transport-agnostic: the gateway delivers parsed
 * messages/binary audio and provides `send`/`close`.
 *
 * No audio is persisted anywhere in this milestone; only transcripts, timings
 * and (for the notice) block proof go to the store.
 */
export class VoiceSession {
  readonly sessionId = randomUUID();
  private readonly deps: VoiceSessionDeps;
  private state: AgentState = "connecting";
  private interactionId: string | null = null;
  private agent: { agentId: string; orgName: string; personaPrompt: string; voiceId: string; language: string } | null =
    null;
  private sttSession: SttStreamSession | null = null;
  private sttReady: Promise<SttStreamSession> | null = null;
  private ttsSession: TtsStreamSession | null = null;
  private history: ChatMessage[] = [];
  private seq = 0;
  private turnSeq = 0;
  private llmAbort: AbortController | null = null;
  private ttsAbort: AbortController | null = null;
  private readonly utterances = new Map<string, ActiveUtterance>();
  private currentUtteranceId: string | null = null;
  private noticeStage: "none" | "disclosure" | "notice" = "none";
  /** True once the disclosure + notice handshake completed with proof. */
  private noticeConfirmed = false;
  /** Set when the caller objects to recording: the call continues unrecorded. */
  private recordingObjection = false;
  private noticeTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private silenceFallbackTimer: NodeJS.Timeout | null = null;
  private playbackBackstopTimer: NodeJS.Timeout | null = null;
  private silencePrompted = false;
  private starting = false;
  private activeTimings: TurnTimingsMs | null = null;
  private activeRawReply = "";
  private ended = false;
  private endReason: "caller_hangup" | "agent_ended" | "error" | "timeout" | null = null;
  /** F4: agent turns run, per-turn audio, rate window, session timer. */
  private completedTurns = 0;
  private turnAudioBytes = 0;
  private turnAudioCapped = false;
  private rateWindowStartMs: number | null = null;
  private rateWindowBytes = 0;
  private droppedBytes = 0;
  private maxSessionTimer: NodeJS.Timeout | null = null;

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
  }

  get currentState(): AgentState {
    return this.state;
  }

  get currentInteractionId(): string | null {
    return this.interactionId;
  }

  /** Entry point for validated client messages. Never throws. */
  async handleMessage(message: ClientMessage): Promise<void> {
    if (this.ended) return;
    try {
      switch (message.type) {
        case "session.start":
          await this.handleStart(message.agentId);
          break;
        case "input.speech_started":
          this.handleSpeechStarted();
          break;
        case "input.speech_ended":
          await this.handleSpeechEnded();
          break;
        case "playback.progress":
          this.handlePlaybackProgress(message.utteranceId, message.playedMs);
          break;
        case "playback.done":
          await this.handlePlaybackDone(message.utteranceId);
          break;
        case "playback.interrupted":
          this.handlePlaybackInterrupted(message.utteranceId, message.playedMs);
          break;
        case "session.end":
          await this.endSession("caller_hangup");
          break;
      }
    } catch (error) {
      this.deps.log({ msg: "session.message_failed", error: errorMessage(error) });
      await this.recover(errorMessage(error));
    }
  }

  /** Entry point for mic audio frames (PCM s16le mono 16 kHz). */
  handleAudio(pcm: Buffer): void {
    if (this.ended || this.interactionId === null) return;
    if (this.state !== "listening" && this.state !== "thinking" && this.state !== "speaking") return;
    // F4: per-second byte budget; over-budget frames are dropped, and a
    // sustained flood ends the session (bounds hosted STT spend).
    const now = performance.now();
    if (this.rateWindowStartMs === null || now - this.rateWindowStartMs >= 1000) {
      this.rateWindowStartMs = now;
      this.rateWindowBytes = 0;
    }
    if (this.rateWindowBytes + pcm.length > this.deps.config.maxBytesPerSec) {
      this.droppedBytes += pcm.length;
      this.deps.log({
        msg: "session.audio_rate_limited",
        droppedBytes: this.droppedBytes,
        budget: this.deps.config.maxBytesPerSec,
      });
      if (this.droppedBytes > this.deps.config.maxBytesPerSec * FLOOD_CUTOFF_WINDOWS) {
        this.deps.log({ msg: "session.audio_flood", droppedBytes: this.droppedBytes });
        void this.endSession("agent_ended", {
          fatal: { code: "internal", message: "Audio rate limit exceeded; ending the call." },
        });
      }
      return;
    }
    this.rateWindowBytes += pcm.length;
    // F4: a single turn's audio is capped; the excess is dropped (the turn
    // finalizes short) but the session survives.
    this.turnAudioBytes += pcm.length;
    if (this.turnAudioBytes > this.deps.config.maxTurnAudioS * INPUT_BYTES_PER_SEC) {
      if (!this.turnAudioCapped) {
        this.turnAudioCapped = true;
        this.deps.log({
          msg: "session.turn_audio_capped",
          turnAudioBytes: this.turnAudioBytes,
          maxTurnAudioS: this.deps.config.maxTurnAudioS,
        });
      }
      return;
    }
    this.sttSession?.sendAudio(pcm);
  }

  /** The transport went away; release vendor sessions and close the interaction. */
  async handleTransportClose(): Promise<void> {
    if (!this.ended) await this.endSession(this.endReason ?? "caller_hangup", { quiet: true });
  }

  // ---------- session start & notice handshake ----------

  private async handleStart(agentId: string | undefined): Promise<void> {
    if (this.interactionId !== null || this.starting) return;
    this.starting = true;
    const { store, tenantId } = this.deps;
    const agent = await store.getAgentForSession(tenantId, agentId);
    this.agent = {
      agentId: agent.agentId,
      orgName: agent.orgName,
      personaPrompt: agent.personaPrompt,
      voiceId: agent.voiceId ?? this.deps.config.defaultVoiceId,
      language: agent.language,
    };
    const { interactionId } = await store.startInteraction({
      tenantId,
      agentId: this.agent.agentId,
      channel: "web_voice",
      direction: "inbound",
    });
    this.interactionId = interactionId;
    await store.setRecordingState(tenantId, interactionId, "notice_playing");
    this.deps.send({
      type: "session.ready",
      protocolVersion: VOICE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      interactionId,
      outputSampleRate: this.deps.config.outputSampleRate,
      voiceId: this.agent.voiceId,
      sttModelId: this.deps.stt.modelId,
      ttsModelId: this.deps.tts.modelId,
      llmModel: this.deps.llm.model,
    });
    this.setState("notice");
    // F4: maximum call duration (AGENTS.md 10.3), the backstop behind every
    // other cap. Cleared in endSession.
    this.maxSessionTimer = setTimeout(() => {
      this.maxSessionTimer = null;
      if (this.ended) return;
      this.deps.log({ msg: "session.duration_capped", maxSessionS: this.deps.config.maxSessionS });
      void this.endSession("agent_ended", {
        fatal: { code: "internal", message: "This call has reached its maximum length; ending now." },
      });
    }, this.deps.config.maxSessionS * 1000);
    this.maxSessionTimer.unref?.();
    // M30: overlap the TTS connect with the disclosure REST render (at most 2
    // concurrent Cartesia calls on this plan). STT connects while the notice
    // plays and is awaited lazily on the first turn instead of blocking
    // first audio.
    const [ttsSession, disclosure] = await Promise.all([
      this.deps.tts.startSession({ sampleRate: this.deps.config.outputSampleRate }),
      this.deps.blocks.render(DISCLOSE_AI_BLOCK, {
        orgName: this.agent.orgName,
        voiceId: this.agent.voiceId,
      }),
    ]);
    if (this.ended) {
      await ttsSession.close().catch(() => undefined);
      return;
    }
    this.ttsSession = ttsSession;
    // Warm the LLM connection during the notice handshake (best effort).
    void this.deps.llm.prewarm?.().catch((error: unknown) =>
      this.deps.log({ msg: "llm.prewarm_failed", error: errorMessage(error) }),
    );
    this.sttReady = this.connectStt();
    // Pre-render the remaining blocks in the background (notice first, so the
    // disclosure->notice gap never waits on synthesis); every play path
    // re-renders on demand, so a background failure only costs latency.
    void this.preRenderBackgroundBlocks().catch((error: unknown) =>
      this.deps.log({ msg: "blocks.prerender_failed", error: errorMessage(error) }),
    );
    this.noticeStage = "disclosure";
    this.startNoticeTimer();
    await this.playBlock("notice-disclosure", disclosure);
    this.starting = false;
  }

  /** Start an STT session; assigns it when ready, clears the promise on failure. */
  private connectStt(): Promise<SttStreamSession> {
    const ready = this.deps.stt.startSession({ sampleRate: 16000, language: "en" });
    ready.then(
      (session) => {
        if (!this.ended && this.sttReady === ready) {
          this.sttSession = session;
          session.onEvent((event) => {
            if (this.ended) return;
            if (event.kind === "partial" && event.text !== "") {
              this.deps.send({ type: "transcript.partial", text: event.text });
            }
          });
        } else {
          void session.close().catch(() => undefined);
        }
      },
      () => {
        // Next turn reconnects; the failed turn goes through recover.
        if (this.sttReady === ready) this.sttReady = null;
      },
    );
    return ready;
  }

  private async preRenderBackgroundBlocks(): Promise<void> {
    const agent = this.agent as NonNullable<typeof this.agent>;
    for (const block of [RECORDING_NOTICE_BLOCK, HOLD_BLOCK, SILENCE_PROMPT_BLOCK]) {
      if (this.ended) return;
      await this.deps.blocks.render(block, { orgName: agent.orgName, voiceId: agent.voiceId });
    }
  }

  private startNoticeTimer(): void {
    this.clearNoticeTimer();
    this.noticeTimer = setTimeout(() => {
      void this.failNotice("notice ack timed out");
    }, this.deps.config.noticeAckTimeoutMs);
    this.noticeTimer.unref?.();
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  private async failNotice(reason: string): Promise<void> {
    if (this.ended || this.noticeConfirmed) return;
    // AGENTS.md 9.1 rule 2: an unconfirmed notice is a compliance event, not
    // an ordinary error. Flag the interaction for audit and alert. No audio
    // is persisted in this milestone, so there is nothing to purge.
    this.deps.log({
      msg: "compliance.notice_failed",
      alert: "compliance_reviewer",
      reason,
      interactionId: this.interactionId,
    });
    await this.endSession("error", {
      fatal: { code: "internal", message: "Notice playback was not confirmed." },
      complianceFlags: ["notice_failed"],
    });
  }

  private async playBlock(utteranceId: string, rendered: RenderedBlock): Promise<void> {
    this.deps.log({
      msg: "block.play",
      blockId: rendered.block.id,
      blockVersion: rendered.block.version,
      blockHash: rendered.hash,
    });
    this.trackUtterance(utteranceId, {
      id: utteranceId,
      sentences: [
        { sentence: rendered.text, audioBytes: rendered.pcmS16le.length, durationS: rendered.durationS, words: [] },
      ],
      playedMs: 0,
      done: false,
      firstSentAtMs: null,
    });
    this.deps.send({ type: "agent.text", utteranceId, delta: rendered.text, kind: "block", blockId: rendered.block.id });
    const entry = this.utterances.get(utteranceId);
    if (entry) entry.firstSentAtMs = performance.now();
    this.sendPcmAsAudioMessages(utteranceId, rendered.pcmS16le);
    this.deps.send({ type: "agent.audio.end", utteranceId });
  }

  /** Track an utterance, evicting the oldest done entry past the cap. */
  private trackUtterance(id: string, entry: ActiveUtterance): void {
    this.utterances.set(id, entry);
    if (this.utterances.size <= MAX_TRACKED_UTTERANCES) return;
    for (const [key, value] of this.utterances) {
      if (key !== this.currentUtteranceId && value.done) {
        this.utterances.delete(key);
        return;
      }
    }
    for (const key of this.utterances.keys()) {
      if (key !== this.currentUtteranceId) {
        this.utterances.delete(key);
        return;
      }
    }
  }

  private sendPcmAsAudioMessages(utteranceId: string, pcm: Buffer): void {
    // ~100 ms frames at 24 kHz s16 mono.
    const frameBytes = 4800;
    let seq = 0;
    for (let offset = 0; offset < pcm.length; offset += frameBytes) {
      this.deps.send({
        type: "agent.audio",
        utteranceId,
        seq: seq++,
        pcmBase64: pcm.subarray(offset, offset + frameBytes).toString("base64"),
      });
    }
  }

  private async handlePlaybackDone(utteranceId: string): Promise<void> {
    const utterance = this.utterances.get(utteranceId);
    if (utterance) {
      utterance.playedMs = Math.round(totalDurationS(utterance.sentences) * 1000);
      utterance.done = true;
    }
    if (this.state === "notice") {
      if (utteranceId === "notice-disclosure" && this.noticeStage === "disclosure") {
        if (!this.noticeAckPlausible(utteranceId)) return;
        this.utterances.delete(utteranceId);
        this.noticeStage = "notice";
        this.startNoticeTimer();
        const notice = await this.deps.blocks.render(RECORDING_NOTICE_BLOCK, {
          orgName: this.agent?.orgName ?? "",
          voiceId: this.agent?.voiceId ?? this.deps.config.defaultVoiceId,
        });
        if (!this.ended) await this.playBlock("notice-notice", notice);
        return;
      }
      if (utteranceId === "notice-notice" && this.noticeStage === "notice") {
        if (!this.noticeAckPlausible(utteranceId)) return;
        this.utterances.delete(utteranceId);
        this.clearNoticeTimer();
        this.noticeStage = "none";
        const notice = await this.deps.blocks.render(RECORDING_NOTICE_BLOCK, {
          orgName: this.agent?.orgName ?? "",
          voiceId: this.agent?.voiceId ?? this.deps.config.defaultVoiceId,
        });
        const { store, tenantId } = this.deps;
        await store.setRecordingState(tenantId, this.interactionId as string, "notice_confirmed", {
          blockId: notice.block.id,
          blockVersion: notice.block.version,
          blockHash: notice.hash,
          deliveredAt: new Date(),
        });
        await store.setRecordingState(tenantId, this.interactionId as string, "recording");
        this.noticeConfirmed = true;
        this.setState("listening");
        this.armSilenceTimer();
        return;
      }
    }
    if (utteranceId === "hold" || utteranceId === "silence-prompt") {
      this.utterances.delete(utteranceId);
      if (!this.ended && this.currentUtteranceId === utteranceId) {
        this.currentUtteranceId = null;
        this.setState("listening");
        this.armSilenceTimer();
      }
      return;
    }
    // M5: the client heard the whole turn: release the retained id and prune.
    // Unknown ids are harmless no-ops (already pruned or never tracked).
    if (this.currentUtteranceId === utteranceId) {
      this.currentUtteranceId = null;
      this.utterances.delete(utteranceId);
      // Heard-anchored silence window (AGENTS.md 10.3): the 8s clock starts
      // when the caller heard the end, not at send-complete. Stale acks (the
      // backstop already fired, a barge-in retired the turn, a newer turn
      // started) fall through to the no-op prune below.
      if (!this.ended && this.state === "listening") this.armSilenceTimer();
      return;
    }
    this.utterances.delete(utteranceId);
  }

  /**
   * F2: a notice `playback.done` is accepted only if the client plausibly
   * played the block — wall-clock time since the first audio chunk was sent
   * must cover the block duration (minus tolerance). Early or unknown acks
   * are ignored and the notice timeout keeps running (fail closed).
   */
  private noticeAckPlausible(utteranceId: string): boolean {
    const utterance = this.utterances.get(utteranceId);
    const expectedMs = Math.round(totalDurationS(utterance?.sentences ?? []) * 1000);
    const observedMs =
      utterance?.firstSentAtMs === null || utterance?.firstSentAtMs === undefined
        ? null
        : Math.round(performance.now() - utterance.firstSentAtMs);
    const plausible = observedMs !== null && observedMs >= expectedMs - NOTICE_ACK_TOLERANCE_MS;
    if (!plausible) {
      this.deps.log({
        msg: "session.notice_ack_early",
        utteranceId,
        observedMs,
        expectedMs,
      });
    }
    return plausible;
  }

  // ---------- turn loop ----------

  private handleSpeechStarted(): void {
    this.silencePrompted = false;
    this.clearSilenceTimer();
    // F4: new turn, new audio budget.
    this.turnAudioBytes = 0;
    this.turnAudioCapped = false;
    if (this.currentUtteranceId) {
      // Covers speaking/thinking and the M5 playout tail (listening with
      // agent audio still unacked): cancel and truncate to what was heard.
      this.bargeIn(0, "speech_started");
      return;
    }
    if (this.state === "thinking") {
      // M1: speech during the STT finalize wait (or the caller-turn write):
      // abandon the stale turn so the new utterance is neither swallowed
      // nor merged into it. The stale continuation observes the bumped
      // turnSeq and returns without emitting anything.
      this.turnSeq += 1;
      this.sttSession?.reset();
      this.setState("listening");
      // The caller is speaking: no silence clock until their turn resolves
      // (agent reply heard, empty transcript). The timer was cleared above.
    }
  }

  private async handleSpeechEnded(): Promise<void> {
    this.silencePrompted = false;
    if (this.state !== "listening" || !this.ttsSession) return;
    // F4: hard stop on agent turns (bounds hosted LLM/TTS spend per session).
    if (this.completedTurns >= this.deps.config.maxTurns) {
      this.deps.log({
        msg: "session.turns_capped",
        completedTurns: this.completedTurns,
        maxTurns: this.deps.config.maxTurns,
      });
      await this.endSession("agent_ended", {
        fatal: { code: "internal", message: "This call has reached its turn limit; ending now." },
      });
      return;
    }
    const tSpeechEnded = performance.now();
    const turnId = randomUUID();
    const myTurn = ++this.turnSeq;
    this.setState("thinking");
    const timings: TurnTimingsMs = {
      stt: null,
      llm_first_token: null,
      llm_total: null,
      tts_first_audio: null,
      end_to_first_audio: null,
    };
    try {
      // M30: STT connects during the notice; await it here (reconnecting on
      // failure) so a slow connect never blocks session start.
      if (!this.sttSession) {
        this.sttReady ??= this.connectStt();
        try {
          this.sttSession = await this.sttReady;
        } catch (error) {
          this.sttReady = null;
          this.sttSession = null;
          throw error;
        }
      }
      const sttResult = await this.sttSession.finalize();
      if (myTurn !== this.turnSeq || this.ended) return;
      const tSttFinal = performance.now();
      timings.stt = Math.round(tSttFinal - tSpeechEnded);
      const callerText = sttResult.text.trim();
      this.deps.send({ type: "transcript.final", turnId, text: callerText });
      if (callerText === "") {
        this.setState("listening");
        this.armSilenceTimer();
        return;
      }
      if (!this.recordingObjection && RECORDING_OBJECTION_RE.test(callerText)) {
        // M22 (minimal): flag, log, and continue unrecorded from this turn
        // on. No audio is persisted in this milestone; turn writes stop.
        // Full tenant-policy handling (transfer, contact record) is deferred.
        this.recordingObjection = true;
        this.deps.log({ msg: "recording.objection", interactionId: this.interactionId });
      }
      // M29: history and seq update synchronously; the caller-turn DB write
      // runs concurrently with the LLM/TTS pipeline and lands before the
      // agent write (ordering by seq). Errors surface after the pipeline.
      const agent = this.agent as NonNullable<typeof this.agent>;
      // F4: bound LLM input; the full transcript is still stored for audit.
      const llmText =
        callerText.length > this.deps.config.maxTranscriptChars
          ? callerText.slice(0, this.deps.config.maxTranscriptChars)
          : callerText;
      if (llmText !== callerText) {
        this.deps.log({
          msg: "session.transcript_capped",
          chars: callerText.length,
          maxTranscriptChars: this.deps.config.maxTranscriptChars,
        });
      }
      this.history.push({ role: "user", content: llmText });
      this.trimHistory();
      this.seq += 1;
      const callerSeq = this.seq;
      let callerWriteError: unknown = null;
      const callerWriteDone = this.recordingObjection
        ? Promise.resolve()
        : this.deps.store
            .appendTurn(this.deps.tenantId, {
              interactionId: this.interactionId as string,
              seq: callerSeq,
              speaker: "caller",
              text: callerText,
              language: agent.language,
              interrupted: false,
              sttModelId: sttResult.modelId,
              sttConfidence: sttResult.confidence,
              timingsMs: {},
            })
            .then(() => undefined)
            .catch((error: unknown) => {
              callerWriteError = error;
            });
      if (myTurn !== this.turnSeq || this.ended) return;
      this.completedTurns += 1;
      await this.runAgentTurn(turnId, myTurn, tSpeechEnded, tSttFinal, timings, {
        done: callerWriteDone,
        error: () => callerWriteError,
      });
    } catch (error) {
      if (myTurn !== this.turnSeq || this.ended) return;
      throw error;
    }
  }

  private async runAgentTurn(
    turnId: string,
    myTurn: number,
    tSpeechEnded: number,
    tSttFinal: number,
    timings: TurnTimingsMs,
    callerWrite: { done: Promise<void>; error: () => unknown },
  ): Promise<void> {
    const agent = this.agent as NonNullable<typeof this.agent>;
    const ttsSession = this.ttsSession as TtsStreamSession;
    // M4: per-turn controller locals; teardown only clears what it owns so a
    // slow-teardown turn can never unplug the next turn's controllers.
    const llmAbort = new AbortController();
    const ttsAbort = new AbortController();
    this.llmAbort = llmAbort;
    this.ttsAbort = ttsAbort;
    this.activeTimings = timings;
    this.activeRawReply = "";
    const utterance: ActiveUtterance = {
      id: turnId,
      sentences: [],
      playedMs: 0,
      done: false,
      firstSentAtMs: null,
    };
    this.trackUtterance(turnId, utterance);
    this.currentUtteranceId = turnId;
    const messages = this.buildMessages();
    const chunker = new SentenceChunker();
    let rawReply = "";
    let llmFirstAt = 0;
    let usage: { in: number | null; out: number | null; reasoning: number | null } | undefined;
    let audioSeq = 0;
    let ttsFirstAt = 0;
    let firstAudioSentAt = 0;
    let ttsStartAt = 0;
    let ttsDoneAt = 0;
    let sentenceIndex = 0;
    // M27: sentences queue onto a sequential chain instead of blocking the
    // LLM loop, so TTS for sentence N runs while the LLM keeps generating.
    // Order is preserved; staleness is checked per task for barge-in.
    let speakChain = Promise.resolve();
    const speakErrors: unknown[] = [];
    const queueSentence = (sentence: string): void => {
      speakChain = speakChain.then(async () => {
        if (myTurn !== this.turnSeq || this.ended || speakErrors.length > 0) return;
        try {
          await speakSentence(sentence);
        } catch (error) {
          speakErrors.push(error);
        }
      });
    };
    // M28: when the LLM stalls on a terminal-complete sentence, start TTS
    // without waiting for the rest of the stream.
    let idleTimer: NodeJS.Timeout | null = null;
    const clearIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdle = (): void => {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (myTurn !== this.turnSeq || this.ended) return;
        for (const sentence of chunker.flushIfTerminal()) queueSentence(sentence);
      }, this.deps.config.sentenceIdleFlushMs);
      idleTimer.unref?.();
    };
    const speakSentence = async (sentence: string): Promise<void> => {
      if (myTurn !== this.turnSeq || this.ended) return;
      // F3/M19: screen the raw LLM sentence for sensitive values BEFORE
      // normalisation (which would expand digits into words) and synthesis.
      const policy = applySpeakPolicy(sentence);
      if (policy.tripped) {
        this.deps.log({ msg: "guardrail.speak_policy", turnId, kinds: policy.kinds });
      }
      const spoken = normaliseForSpeech(policy.safe);
      if (spoken === "") return;
      if (ttsStartAt === 0) ttsStartAt = performance.now();
      // F3: the client transcript gets the screened sentence, never raw LLM
      // deltas, so echoed PII never reaches the browser either.
      this.deps.send({ type: "agent.text", utteranceId: turnId, delta: `${policy.safe} `, kind: "speech" });
      const contextId = `${turnId}:s${sentenceIndex++}`;
      const ttsSentAt = performance.now();
      // Tracked progressively so a mid-sentence barge-in still sees partial audio/words.
      const entry: SentenceAudio = { sentence: spoken, audioBytes: 0, durationS: 0, words: [] };
      utterance.sentences.push(entry);
      let firstChunk = true;
      for await (const event of ttsSession.speak(spoken, {
        voiceId: agent.voiceId,
        language: "en",
        tone: "neutral",
        speed: 1.0,
        contextId,
        signal: ttsAbort.signal,
      })) {
        if (myTurn !== this.turnSeq) return;
        if (event.kind === "audio") {
          entry.audioBytes += event.chunk.pcmS16le.length;
          entry.durationS = entry.audioBytes / 2 / this.deps.config.outputSampleRate;
          if (firstChunk) {
            firstChunk = false;
            if (ttsFirstAt === 0) {
              ttsFirstAt = performance.now();
              timings.tts_first_audio = Math.round(ttsFirstAt - ttsSentAt);
            }
          }
          this.deps.send({
            type: "agent.audio",
            utteranceId: turnId,
            seq: audioSeq++,
            pcmBase64: event.chunk.pcmS16le.toString("base64"),
          });
          if (firstAudioSentAt === 0) {
            firstAudioSentAt = performance.now();
            timings.end_to_first_audio = Math.round(firstAudioSentAt - tSpeechEnded);
            this.setState("speaking");
          }
        } else if (event.kind === "timestamps") {
          entry.words.push(...event.words);
        }
      }
      ttsDoneAt = performance.now();
    };

    try {
      for await (const event of this.deps.llm.streamChat(messages, { signal: llmAbort.signal })) {
        if (myTurn !== this.turnSeq || this.ended) return;
        if (event.kind === "usage") {
          usage = event.usage;
          continue;
        }
        if (llmFirstAt === 0) {
          llmFirstAt = performance.now();
          timings.llm_first_token = Math.round(llmFirstAt - tSttFinal);
        }
        rawReply += event.text;
        this.activeRawReply = rawReply;
        for (const sentence of chunker.push(event.text)) queueSentence(sentence);
        if (myTurn !== this.turnSeq || this.ended) return;
        armIdle();
      }
      // M31: llm_total covers the LLM stream only, never queued TTS work.
      timings.llm_total = Math.round(performance.now() - tSttFinal);
      clearIdle();
      for (const sentence of chunker.flush()) queueSentence(sentence);
      if (myTurn !== this.turnSeq || this.ended) return;
      await speakChain;
      if (myTurn !== this.turnSeq || this.ended) return;
      if (speakErrors.length > 0) throw speakErrors[0];
    } catch (error) {
      if (myTurn !== this.turnSeq || this.ended) return;
      throw error;
    } finally {
      clearIdle();
      // M4: only clear when the next turn has not already replaced them.
      if (this.llmAbort === llmAbort) this.llmAbort = null;
      if (this.ttsAbort === ttsAbort) this.ttsAbort = null;
    }
    if (myTurn !== this.turnSeq || this.ended) return;
    // M29: land the concurrent caller write before the agent write.
    await callerWrite.done;
    if (myTurn !== this.turnSeq || this.ended) return;
    const callerError = callerWrite.error();
    if (callerError) throw callerError;
    utterance.done = true;
    this.activeTimings = null;
    this.activeRawReply = "";
    const spokenText = utterance.sentences.map((s) => s.sentence).join(" ");
    // M31: TTS span lives in the store record and logs (the wire protocol's
    // TurnTimingsMs is frozen, so turn.metrics keeps the agreed fields).
    const ttsTotal = ttsStartAt === 0 ? null : Math.round(ttsDoneAt - ttsStartAt);
    this.deps.send({ type: "agent.audio.end", utteranceId: turnId });
    this.deps.send({ type: "turn.metrics", turnId, timingsMs: timings });
    this.history.push({ role: "assistant", content: spokenText });
    this.trimHistory();
    this.seq += 1;
    if (!this.recordingObjection) {
      await this.deps.store.appendTurn(this.deps.tenantId, {
        interactionId: this.interactionId as string,
        seq: this.seq,
        speaker: "agent",
        text: rawReply,
        spokenText,
        language: agent.language,
        interrupted: false,
        llmModel: this.deps.llm.model,
        promptVersion: VOICE_SYSTEM_PROMPT_VERSION,
        ttsModelId: this.deps.tts.modelId,
        voiceId: agent.voiceId,
        timingsMs: { ...timings, tts_total: ttsTotal },
        tokens: usage,
      });
    }
    this.logTurn(timings, false, ttsTotal);
    // M5: the last byte is SENT here, not heard: retain currentUtteranceId
    // until playback.done so a playout-tail barge-in still cancels the audio
    // and truncates history to what was heard (AGENTS.md 10.2). State stays
    // `listening` through the tail (least-risky option: barge-in and the
    // speech_ended gate work unchanged); the silence clock does NOT start
    // here. It starts on playback.done (heard-anchored, AGENTS.md 10.3), with
    // a duration+margin backstop below if the ack never arrives.
    this.setState("listening");
    this.armPlaybackBackstop(
      turnId,
      Math.round(totalDurationS(utterance.sentences) * 1000) + PLAYBACK_BACKSTOP_MARGIN_MS,
    );
  }

  // ---------- barge-in ----------

  private handlePlaybackProgress(utteranceId: string, playedMs: number): void {
    const utterance = this.utterances.get(utteranceId);
    if (utterance) utterance.playedMs = Math.max(utterance.playedMs, playedMs);
  }

  private handlePlaybackInterrupted(utteranceId: string, playedMs: number): void {
    this.handlePlaybackProgress(utteranceId, playedMs);
    // M3: a stale/duplicate interrupt for an old utterance must never kill
    // the current turn. The id check also covers the M5 playout tail.
    if (utteranceId !== this.currentUtteranceId || this.currentUtteranceId === null) return;
    this.bargeIn(playedMs, "playback.interrupted");
  }

  private bargeIn(reportedPlayedMs: number, source: string): void {
    const utteranceId = this.currentUtteranceId;
    if (!utteranceId) return;
    const utterance = this.utterances.get(utteranceId);
    // M5 tail: the turn already completed (full text in history and store).
    const wasDone = utterance?.done ?? false;
    const isBlock = utteranceId === "hold" || utteranceId === "silence-prompt";
    this.turnSeq += 1;
    this.llmAbort?.abort();
    this.ttsAbort?.abort();
    this.llmAbort = null;
    this.ttsAbort = null;
    this.currentUtteranceId = null;
    this.utterances.delete(utteranceId);
    const playedMs = Math.max(reportedPlayedMs, utterance?.playedMs ?? 0);
    const spokenText = utterance ? truncateSpoken(utterance.sentences, playedMs) : "";
    const rawReply = this.activeRawReply;
    const timings = this.activeTimings;
    this.activeTimings = null;
    this.activeRawReply = "";
    this.deps.send({ type: "agent.cancelled", utteranceId });
    if (wasDone) {
      // Playout-tail barge: metrics and the full turn were already recorded.
      // Fix history to what was heard instead of appending a duplicate.
      this.replaceLastAssistantMessage(spokenText);
      this.deps.log({ msg: "turn.barged_in", source, playedMs: Math.round(playedMs), tail: true });
      this.setState("listening");
      // The caller is speaking: no silence clock until their turn resolves.
      // Clears the tail backstop so it cannot arm under the new utterance.
      this.clearSilenceTimer();
      return;
    }
    if (timings) this.deps.send({ type: "turn.metrics", turnId: utteranceId, timingsMs: { ...timings } });
    if (utterance && !utterance.done && this.interactionId !== null && !isBlock) {
      utterance.done = true;
      if (!this.recordingObjection) {
        this.seq += 1;
        const seq = this.seq;
        const agent = this.agent;
        void this.deps.store
          .appendTurn(this.deps.tenantId, {
            interactionId: this.interactionId,
            seq,
            speaker: "agent",
            text: rawReply,
            spokenText,
            language: agent?.language ?? "en",
            interrupted: true,
            llmModel: this.deps.llm.model,
            promptVersion: VOICE_SYSTEM_PROMPT_VERSION,
            ttsModelId: this.deps.tts.modelId,
            voiceId: agent?.voiceId ?? this.deps.config.defaultVoiceId,
            timingsMs: timings ? { ...timings } : {},
          })
          .catch((error: unknown) => this.deps.log({ msg: "store.append_turn_failed", error: errorMessage(error) }));
      }
    }
    // History keeps only what the caller actually heard. Fixed fallback
    // blocks are not model content and stay out of history.
    if (spokenText !== "" && !isBlock) {
      this.history.push({ role: "assistant", content: spokenText });
      this.trimHistory();
    }
    this.deps.log({ msg: "turn.barged_in", source, playedMs: Math.round(playedMs) });
    this.setState("listening");
    // The caller is speaking: no silence clock until their turn resolves.
    this.clearSilenceTimer();
  }

  /** Replace the last assistant message (M5 tail fix) or drop it if unheard. */
  private replaceLastAssistantMessage(spokenText: string): void {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i]?.role === "assistant") {
        if (spokenText === "") this.history.splice(i, 1);
        else this.history[i] = { role: "assistant", content: spokenText };
        return;
      }
    }
  }

  // ---------- fallbacks & silence ----------

  private async recover(reason: string): Promise<void> {
    if (this.ended) return;
    if (!this.noticeConfirmed) {
      // B1: before the notice handshake the hold path is forbidden — the
      // caller must never hear other content or reach `listening` without
      // disclosure + notice proof (AGENTS.md 9.1 rules 1-2). End flagged.
      await this.failNotice(`recover before notice confirmed: ${reason}`);
      return;
    }
    if (!this.sttSession || !this.ttsSession || !this.interactionId) {
      // F7: vendor/adapter detail stays server-side; the client gets a generic message.
      this.deps.log({ msg: "session.start_failed", reason });
      await this.endSession("error", {
        fatal: { code: "internal", message: "Voice session failed to start." },
      });
      return;
    }
    this.turnSeq += 1;
    this.llmAbort?.abort();
    this.ttsAbort?.abort();
    this.llmAbort = null;
    this.ttsAbort = null;
    const code = reason.includes("stt") ? "stt_failed" : reason.includes("llm") ? "llm_failed" : "tts_failed";
    this.deps.send({ type: "error", code, message: "Speech processing hit a snag; holding.", fatal: false });
    try {
      const hold = await this.deps.blocks.render(HOLD_BLOCK, {
        orgName: this.agent?.orgName ?? "",
        voiceId: this.agent?.voiceId ?? this.deps.config.defaultVoiceId,
      });
      if (this.ended) return;
      // Leaving listening: clear any stale silence/backstop arm so no prompt
      // can fire under the hold audio. Hold's playback.done re-arms.
      this.clearSilenceTimer();
      this.currentUtteranceId = "hold";
      this.setState("speaking");
      await this.playBlock("hold", hold);
    } catch (error) {
      // F7: keep vendor detail server-side.
      this.deps.log({ msg: "session.fallback_failed", error: errorMessage(error) });
      await this.endSession("error", {
        fatal: { code: "internal", message: "Speech processing failed; ending the call." },
      });
    }
  }

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    const afterMs = this.silencePrompted ? this.deps.config.silenceEndAfterMs : this.deps.config.silencePromptAfterMs;
    this.silenceTimer = setTimeout(() => {
      void this.handleSilenceTimeout().catch((error: unknown) =>
        this.deps.log({ msg: "silence.timeout_failed", error: errorMessage(error) }),
      );
    }, afterMs);
    this.silenceTimer.unref?.();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.silenceFallbackTimer) clearTimeout(this.silenceFallbackTimer);
    this.silenceFallbackTimer = null;
    if (this.playbackBackstopTimer) clearTimeout(this.playbackBackstopTimer);
    this.playbackBackstopTimer = null;
  }

  /**
   * Backstop if `playback.done` never arrives (suspended tab, lost message):
   * after the sent audio duration + margin, retire the still-unacked utterance
   * and start the normal silence window. Fails toward a LATE prompt, never
   * early. Cancelled by the ack (which arms the real window), by barge-in, and
   * by teardown.
   */
  private armPlaybackBackstop(utteranceId: string, delayMs: number): void {
    this.clearSilenceTimer();
    this.playbackBackstopTimer = setTimeout(() => {
      this.playbackBackstopTimer = null;
      if (this.ended || this.currentUtteranceId !== utteranceId) return;
      const utterance = this.utterances.get(utteranceId);
      const durationMs = Math.round(totalDurationS(utterance?.sentences ?? []) * 1000);
      this.deps.log({ msg: "silence.playback_backstop_used", utteranceId, durationMs, delayMs });
      this.currentUtteranceId = null;
      this.utterances.delete(utteranceId);
      if (this.state === "listening") this.armSilenceTimer();
    }, delayMs);
    this.playbackBackstopTimer.unref?.();
  }

  private async handleSilenceTimeout(): Promise<void> {
    if (this.ended || this.state !== "listening") return;
    // While agent audio is still unacked the caller is hearing it, not silent:
    // never prompt and never overwrite the in-flight utterance id. The ack (or
    // the backstop) starts the window. This guard also covers the M5 tail,
    // where state is `listening` during playout.
    if (this.currentUtteranceId !== null) return;
    if (!this.silencePrompted) {
      this.silencePrompted = true;
      try {
        const prompt = await this.deps.blocks.render(SILENCE_PROMPT_BLOCK, {
          orgName: this.agent?.orgName ?? "",
          voiceId: this.agent?.voiceId ?? this.deps.config.defaultVoiceId,
        });
        // Re-check after the await: a new turn may have started while rendering.
        if (this.ended || this.state !== "listening" || this.currentUtteranceId !== null) return;
        this.currentUtteranceId = "silence-prompt";
        this.setState("speaking");
        await this.playBlock("silence-prompt", prompt);
        // If the client never acks, fall back to listening so the end timer runs.
        // Tracked so barge-in and teardown clear it (no orphaned timers).
        if (this.silenceFallbackTimer) clearTimeout(this.silenceFallbackTimer);
        this.silenceFallbackTimer = setTimeout(() => {
          this.silenceFallbackTimer = null;
          if (!this.ended && this.currentUtteranceId === "silence-prompt") {
            this.currentUtteranceId = null;
            this.setState("listening");
            this.armSilenceTimer();
          }
        }, 15000);
        this.silenceFallbackTimer.unref?.();
      } catch (error) {
        this.deps.log({ msg: "silence.prompt_failed", error: errorMessage(error) });
        this.armSilenceTimer();
      }
      return;
    }
    await this.endSession("timeout");
  }

  // ---------- teardown ----------

  private async endSession(
    reason: "caller_hangup" | "agent_ended" | "error" | "timeout",
    opts: {
      quiet?: boolean;
      fatal?: { code: "bad_message" | "internal"; message: string };
      complianceFlags?: string[];
    } = {},
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    this.turnSeq += 1;
    this.clearNoticeTimer();
    this.clearSilenceTimer();
    if (this.maxSessionTimer) clearTimeout(this.maxSessionTimer);
    this.maxSessionTimer = null;
    this.llmAbort?.abort();
    this.ttsAbort?.abort();
    if (opts.fatal && !opts.quiet) {
      this.deps.send({ type: "error", code: opts.fatal.code, message: opts.fatal.message, fatal: true });
    }
    if (!opts.quiet) this.setState("ended");
    // M30: the STT connect may still be in flight; close it when it lands.
    const sttClose = this.sttSession
      ? this.sttSession.close().catch(() => undefined)
      : this.sttReady?.then((session) => session.close()).catch(() => undefined);
    await Promise.all([sttClose, this.ttsSession?.close().catch(() => undefined)]);
    this.sttReady = null;
    this.sttSession = null;
    this.ttsSession = null;
    if (this.interactionId !== null) {
      await this.deps.store
        .endInteraction(this.deps.tenantId, this.interactionId, reason, {
          complianceFlags: opts.complianceFlags,
        })
        .catch((error: unknown) => this.deps.log({ msg: "store.end_interaction_failed", error: errorMessage(error) }));
    }
    this.deps.close(1000, reason);
  }

  // ---------- helpers ----------

  private setState(state: AgentState): void {
    if (this.ended && state !== "ended") return;
    this.state = state;
    this.deps.send({ type: "state", state });
  }

  private buildMessages(): ChatMessage[] {
    const agent = this.agent as NonNullable<typeof this.agent>;
    const system = buildSystemPrompt(agent.personaPrompt);
    const tail = this.history.slice(-this.deps.config.maxHistoryTurns * 2);
    return [{ role: "system", content: system }, ...tail];
  }

  private trimHistory(): void {
    const max = this.deps.config.maxHistoryTurns * 2;
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  private logTurn(timings: TurnTimingsMs, interrupted: boolean, ttsTotal: number | null = null): void {
    // Ids and timings only: never transcript text, never keys.
    this.deps.log({
      msg: "turn.completed",
      sessionId: this.sessionId,
      interactionId: this.interactionId,
      interrupted,
      stt_ms: timings.stt,
      llm_first_token_ms: timings.llm_first_token,
      llm_total_ms: timings.llm_total,
      tts_first_audio_ms: timings.tts_first_audio,
      tts_total_ms: ttsTotal,
      end_to_first_audio_ms: timings.end_to_first_audio,
    });
  }
}

/** Total audio duration of fully synthesised sentences. */
function totalDurationS(sentences: SentenceAudio[]): number {
  return sentences.reduce((sum, s) => sum + s.durationS, 0);
}

/**
 * Truncate an utterance to what was heard: whole sentences fully inside
 * `playedMs`, plus (when word timestamps exist) the words heard in the partial
 * sentence; otherwise the partial sentence is dropped.
 */
export function truncateSpoken(sentences: SentenceAudio[], playedMs: number): string {
  const parts: string[] = [];
  let offsetMs = 0;
  for (const sentence of sentences) {
    const sentenceMs = sentence.durationS * 1000;
    if (playedMs >= offsetMs + sentenceMs - 1) {
      parts.push(sentence.sentence);
    } else if (playedMs > offsetMs && sentence.words.length > 0) {
      const heard = sentence.words
        .filter((w) => w.endS * 1000 <= playedMs - offsetMs)
        .map((w) => w.text);
      if (heard.length > 0) parts.push(heard.join(" "));
      break;
    } else {
      break;
    }
    offsetMs += sentenceMs;
  }
  return parts.join(" ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
