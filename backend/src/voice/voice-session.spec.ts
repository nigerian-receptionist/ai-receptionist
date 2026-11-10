import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChatMessage,
  LlmClient,
  LlmEvent,
  SpeechToText,
  SttEvent,
  SttResult,
  SttStreamSession,
  TextToSpeech,
  TtsStreamEvent,
  TtsStreamSession,
  WordTiming,
} from "./adapters/types";
import { BlockRenderer, type BlockDefinition } from "./blocks/block-cache";
import type { ClientMessage } from "./client-messages";
import type { ServerMessage } from "./protocol";
import { InMemoryInteractionStore } from "./testing/in-memory-interaction-store";
import { VoiceSession, truncateSpoken, type VoiceSessionConfig } from "./voice-session";

const TENANT = "0195f3a0-0000-7000-8000-000000000001";

/** Deterministic PCM: 24 kHz s16le of `seconds` duration. */
function makePcm(seconds: number, rate = 24000): Buffer {
  const samples = Math.floor(seconds * rate);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.floor(1000 * Math.sin(i / 100)), i * 2);
  return pcm;
}

class FakeSttSession implements SttStreamSession {
  audioBytes = 0;
  finals: string[];
  closed = false;
  /** When true, finalize() parks until release() or reset(). */
  deferred = false;
  private parked: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  constructor(finals: string[]) {
    this.finals = [...finals];
  }
  sendAudio(pcm: Buffer): void {
    this.audioBytes += pcm.length;
  }
  onEvent(_listener: (event: SttEvent) => void): void {
    // Partial events are not exercised here.
  }
  get parkedFinalizes(): number {
    return this.parked.length;
  }
  async finalize(): Promise<SttResult> {
    const text = this.finals.shift() ?? "";
    if (this.deferred) {
      await new Promise<void>((resolve, reject) => this.parked.push({ resolve, reject }));
    }
    return {
      text,
      language: "en",
      confidence: 0.9,
      words: [],
      audioS: this.audioBytes / 2 / 16000,
      latencyS: 0.01,
      modelId: "stt_fake@test",
    };
  }
  reset(): void {
    const parked = this.parked;
    this.parked = [];
    for (const entry of parked) entry.reject(aborted());
  }
  /** Resolve every parked finalize (test control). */
  release(): void {
    const parked = this.parked;
    this.parked = [];
    for (const entry of parked) entry.resolve();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeStt implements SpeechToText {
  readonly modelId = "stt_fake@test";
  sessions: FakeSttSession[] = [];
  /** When set, startSession parks until the gate opens (M30 tests). */
  startGate: Promise<void> | null = null;
  startEntered = false;
  constructor(private readonly finals: string[]) {}
  async startSession(): Promise<SttStreamSession> {
    this.startEntered = true;
    if (this.startGate) await this.startGate;
    const session = new FakeSttSession(this.finals);
    this.sessions.push(session);
    return session;
  }
}

interface FakeUtterance {
  pcm: Buffer;
  words: WordTiming[];
}

class FakeTtsSession implements TtsStreamSession {
  /** Context ids that saw an abort, vs ran to `done` (abort-handover tests). */
  readonly abortedContexts: string[] = [];
  readonly completedContexts: string[] = [];
  /**
   * text -> canned audio; default one chunk per sentence. When `gate` is set,
   * speak parks after the first audio chunk until the gate opens, so tests can
   * interrupt deterministically mid-utterance. `gateFor` gates per text.
   */
  private readonly activeContexts = new Set<string>();
  constructor(
    private readonly canned: Map<string, FakeUtterance> = new Map(),
    private gate: Promise<void> | null = null,
    private readonly spokenLog: string[] | null = null,
    private readonly gateFor: ((text: string) => Promise<void> | null) | null = null,
    private readonly speakDelayMs = 0,
  ) {}
  async *speak(
    text: string,
    opts: { contextId: string; signal?: AbortSignal },
  ): AsyncIterable<TtsStreamEvent> {
    this.spokenLog?.push(text);
    if (this.activeContexts.has(opts.contextId)) throw new Error("duplicate tts context id");
    this.activeContexts.add(opts.contextId);
    if (this.speakDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.speakDelayMs));
    try {
      const found = this.canned.get(text);
      const pcm = found?.pcm ?? makePcm(0.3);
      const words = found?.words ?? [];
      yield { kind: "audio", chunk: { pcmS16le: pcm, sampleRate: 24000, isFirst: true, isLast: true } };
      if (opts.signal?.aborted) throw aborted();
      await tick();
      if (words.length > 0) yield { kind: "timestamps", words };
      if (opts.signal?.aborted) throw aborted();
      const gate = this.gateFor?.(text) ?? this.gate;
      if (gate) await gate;
      if (opts.signal?.aborted) throw aborted();
      yield {
        kind: "done",
        result: {
          pcmS16le: Buffer.alloc(0),
          sampleRate: 24000,
          durationS: pcm.length / 2 / 24000,
          timeToFirstAudioS: 0.01,
          totalLatencyS: 0.02,
          voiceId: "fake",
          modelId: "tts_fake@test",
          textSpoken: text,
          words,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") this.abortedContexts.push(opts.contextId);
      throw error;
    } finally {
      this.activeContexts.delete(opts.contextId);
    }
    this.completedContexts.push(opts.contextId);
  }
  async close(): Promise<void> {}
}

class FakeTts implements TextToSpeech {
  readonly modelId = "tts_fake@test";
  readonly spoken: string[] = [];
  readonly ttsSession: FakeTtsSession;
  /** When set, startSession parks until the gate opens (M30 tests). */
  startGate: Promise<void> | null = null;
  startEntered = false;
  constructor(
    canned: Map<string, FakeUtterance> = new Map(),
    gate: Promise<void> | null = null,
    private readonly blockSeconds = 0.05,
    gateFor: ((text: string) => Promise<void> | null) | null = null,
    speakDelayMs = 0,
  ) {
    this.ttsSession = new FakeTtsSession(canned, gate, this.spoken, gateFor, speakDelayMs);
  }
  voices() {
    return [{ voiceId: "fake-voice", language: "en", gender: "unspecified", tones: ["neutral"] }];
  }
  async synthesize(text: string): Promise<{
    pcmS16le: Buffer;
    sampleRate: number;
    durationS: number;
    timeToFirstAudioS: number;
    totalLatencyS: number;
    voiceId: string;
    modelId: string;
    textSpoken: string;
    words: WordTiming[];
  }> {
    const pcm = makePcm(this.blockSeconds);
    return {
      pcmS16le: pcm,
      sampleRate: 24000,
      durationS: this.blockSeconds,
      timeToFirstAudioS: 0.01,
      totalLatencyS: 0.02,
      voiceId: "fake-voice",
      modelId: this.modelId,
      textSpoken: text,
      words: [],
    };
  }
  async startSession(): Promise<TtsStreamSession> {
    this.startEntered = true;
    if (this.startGate) await this.startGate;
    return this.ttsSession;
  }
}

class FakeLlm implements LlmClient {
  readonly model = "llm_fake@test";
  readonly seenMessages: ChatMessage[][] = [];
  /** Replies whose streams ran to completion (M27 pipelining tests). */
  readonly finishedReplies: string[] = [];
  /** When set, the stream parks after yielding word `afterWords` (M28 tests). */
  barrier: { afterWords: number; gate: Promise<void> } | null = null;
  constructor(readonly replies: string[]) {}
  async *streamChat(messages: ChatMessage[], opts: { signal?: AbortSignal }): AsyncIterable<LlmEvent> {
    this.seenMessages.push(messages);
    const reply = this.replies.shift() ?? "Okay.";
    const words = reply.split(" ");
    for (let i = 0; i < words.length; i += 1) {
      if (opts.signal?.aborted) throw aborted();
      await tick();
      if (opts.signal?.aborted) throw aborted();
      const bare = i === words.length - 1 || (this.barrier !== null && i === this.barrier.afterWords);
      yield { kind: "delta", text: bare ? (words[i] as string) : `${words[i]} ` };
      if (this.barrier !== null && i === this.barrier.afterWords) {
        const gate = this.barrier.gate;
        this.barrier = null;
        await gate;
        if (opts.signal?.aborted) throw aborted();
      }
    }
    yield { kind: "usage", usage: { in: 10, out: 5, reasoning: 2 } };
    this.finishedReplies.push(reply);
  }
}

function aborted(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  session: VoiceSession;
  sent: ServerMessage[];
  closed: { code: number; reason: string }[];
  logs: Record<string, unknown>[];
  store: InMemoryInteractionStore;
  stt: FakeStt;
  tts: FakeTts;
  llm: FakeLlm;
  blocks: BlockRenderer;
  interactionId: () => string;
}

function makeHarness(opts: {
  sttFinals?: string[];
  llmReplies?: string[];
  ttsCanned?: Map<string, FakeUtterance>;
  ttsGate?: Promise<void> | null;
  ttsGateFor?: ((text: string) => Promise<void> | null) | null;
  ttsSpeakDelayMs?: number;
  blockSeconds?: number;
  config?: Partial<VoiceSessionConfig>;
} = {}): Harness {
  const sent: ServerMessage[] = [];
  const closed: { code: number; reason: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const store = new InMemoryInteractionStore();
  const stt = new FakeStt(opts.sttFinals ?? []);
  const tts = new FakeTts(
    opts.ttsCanned,
    opts.ttsGate ?? null,
    opts.blockSeconds,
    opts.ttsGateFor ?? null,
    opts.ttsSpeakDelayMs ?? 0,
  );
  const llm = new FakeLlm(opts.llmReplies ?? []);
  const blocks = new BlockRenderer(tts, mkdtempSync(join(tmpdir(), "blocks-")));
  const session = new VoiceSession({
    tenantId: TENANT,
    store,
    stt,
    tts,
    llm,
    blocks,
    config: {
      defaultVoiceId: "fake-voice",
      outputSampleRate: 24000,
      maxHistoryTurns: 12,
      silencePromptAfterMs: 60_000,
      silenceEndAfterMs: 60_000,
      noticeAckTimeoutMs: 5000,
      sentenceIdleFlushMs: 120,
      maxTurns: 60,
      maxTurnAudioS: 30,
      maxSessionS: 900,
      maxBytesPerSec: 64000,
      maxTranscriptChars: 2000,
      ...opts.config,
    },
    send: (message) => sent.push(message),
    close: (code, reason) => closed.push({ code, reason }),
    log: (fields) => logs.push(fields),
  });
  return {
    session,
    sent,
    closed,
    logs,
    store,
    stt,
    tts,
    llm,
    blocks,
    interactionId: () => {
      const id = session.currentInteractionId;
      if (!id) throw new Error("no interaction yet");
      return id;
    },
  };
}

const START: ClientMessage = { type: "session.start", protocolVersion: 1, inputSampleRate: 16000 };

async function completeNotice(h: Harness): Promise<void> {
  await h.session.handleMessage(START);
  await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-disclosure" });
  await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-notice" });
}

function states(h: Harness): string[] {
  return h.sent.filter((m) => m.type === "state").map((m) => (m as { state: string }).state);
}

describe("VoiceSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("plays disclosure then notice before listening, and records notice proof", async () => {
    const h = makeHarness();
    await h.session.handleMessage(START);

    expect(h.sent[0]?.type).toBe("session.ready");
    expect(states(h)).toEqual(["notice"]);
    const texts = h.sent.filter((m) => m.type === "agent.text");
    expect(texts[0]).toMatchObject({ utteranceId: "notice-disclosure", kind: "block", blockId: "disclose_ai" });
    expect(h.session.currentState).toBe("notice");

    // Mic audio before listening is dropped.
    h.session.handleAudio(Buffer.alloc(640));
    expect(h.stt.sessions[0]?.audioBytes ?? 0).toBe(0);

    await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-disclosure" });
    expect(h.session.currentState).toBe("notice");
    const texts2 = h.sent.filter((m) => m.type === "agent.text");
    expect(texts2[1]).toMatchObject({ utteranceId: "notice-notice", kind: "block", blockId: "recording_notice" });

    await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-notice" });
    expect(h.session.currentState).toBe("listening");
    expect(states(h)).toEqual(["notice", "listening"]);

    const interaction = h.store.interactions.get(h.interactionId());
    expect(interaction?.recordingState).toBe("recording");
    expect(interaction?.noticeProof).toMatchObject({ blockId: "recording_notice", blockVersion: 1 });
    expect(typeof interaction?.noticeProof?.blockHash).toBe("string");

    // Audio flows once listening.
    h.session.handleAudio(Buffer.alloc(640));
    expect(h.stt.sessions[0]?.audioBytes).toBe(640);
  });

  it("runs a full turn with timings, transcript and stored turns", async () => {
    const h = makeHarness({
      sttFinals: ["I want to know my balance."],
      llmReplies: ["Your balance is twelve thousand naira."],
    });
    await completeNotice(h);
    h.session.handleAudio(Buffer.alloc(3200));
    await h.session.handleMessage({ type: "input.speech_started", atMs: 0 });
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });

    expect(h.session.currentState).toBe("listening");
    const final = h.sent.find((m) => m.type === "transcript.final");
    expect(final).toMatchObject({ text: "I want to know my balance." });
    expect(h.sent.some((m) => m.type === "agent.audio")).toBe(true);
    expect(h.sent.some((m) => m.type === "agent.audio.end")).toBe(true);
    const metrics = h.sent.find((m) => m.type === "turn.metrics");
    expect(metrics?.type).toBe("turn.metrics");
    if (metrics?.type === "turn.metrics") {
      for (const value of Object.values(metrics.timingsMs)) expect(typeof value).toBe("number");
    }
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.map((t) => t.speaker)).toEqual(["caller", "agent"]);
    expect(turns[1]).toMatchObject({ interrupted: false, tokens: { in: 10, out: 5, reasoning: 2 } });
    expect(turns[1]?.spokenText).toContain("twelve thousand naira");
  });

  it("skips the LLM when the final transcript is empty", async () => {
    const h = makeHarness({ sttFinals: ["  "], llmReplies: ["Should not be used."] });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
    expect(h.session.currentState).toBe("listening");
    expect(h.llm.seenMessages).toHaveLength(0);
    expect(h.sent.some((m) => m.type === "turn.metrics")).toBe(false);
  });

  it("barge-in cancels speech and stores only what was heard", async () => {
    const sentence = "Hello there friend.";
    const canned = new Map<string, FakeUtterance>([
      [
        sentence,
        {
          pcm: makePcm(1.2),
          words: [
            { text: "Hello", startS: 0, endS: 0.4, confidence: null },
            { text: "there", startS: 0.4, endS: 0.8, confidence: null },
            { text: "friend.", startS: 0.8, endS: 1.2, confidence: null },
          ],
        },
      ],
    ]);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: [sentence], ttsCanned: canned, ttsGate: gate });
    await completeNotice(h);
    const turnPromise = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    // Wait for the turn's first audio (state is speaking), then interrupt after 500 ms of playout.
    await vi.waitFor(() => {
      expect(h.sent.some((m) => m.type === "transcript.final")).toBe(true);
    });
    const turnAudioId = currentTurnId(h);
    await vi.waitFor(() => {
      expect(
        h.sent.some((m) => m.type === "agent.audio" && (m as { utteranceId: string }).utteranceId === turnAudioId),
      ).toBe(true);
    });
    expect(h.session.currentState).toBe("speaking");
    await h.session.handleMessage({ type: "playback.progress", utteranceId: currentTurnId(h), playedMs: 500 });
    await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
    openGate();
    await turnPromise;

    expect(h.session.currentState).toBe("listening");
    expect(h.sent.some((m) => m.type === "agent.cancelled")).toBe(true);
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    const agentTurn = turns.find((t) => t.speaker === "agent");
    expect(agentTurn).toMatchObject({ interrupted: true, spokenText: "Hello" });
    // History keeps only the spoken part: the next LLM call sees the truncation.
    h.stt.sessions[0]?.finals.push("Thanks.");
    h.llm.replies.push("You are welcome.");
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 20 });
    const lastMessages = h.llm.seenMessages[h.llm.seenMessages.length - 1] ?? [];
    const assistantMessages = lastMessages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toEqual([{ role: "assistant", content: "Hello" }]);
  });

  it("handles playback.interrupted as barge-in", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: ["First sentence here. Second one follows."], ttsGate: gate });
    await completeNotice(h);
    const turnPromise = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    await vi.waitFor(() => {
      expect(h.sent.some((m) => m.type === "transcript.final")).toBe(true);
    });
    const turnId = currentTurnId(h);
    await vi.waitFor(() => {
      expect(
        h.sent.some((m) => m.type === "agent.audio" && (m as { utteranceId: string }).utteranceId === turnId),
      ).toBe(true);
    });
    expect(h.session.currentState).toBe("speaking");
    await h.session.handleMessage({ type: "playback.interrupted", utteranceId: turnId, playedMs: 10 });
    openGate();
    await turnPromise;
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.find((t) => t.speaker === "agent")).toMatchObject({ interrupted: true });
  });

  it("plays a fallback block instead of going silent when the LLM fails", async () => {
    const h = makeHarness({ sttFinals: ["Hello?"] });
    // Break the LLM.
    const broken = h.llm as unknown as { streamChat: () => AsyncIterable<LlmEvent> };
    broken.streamChat = (): AsyncIterable<LlmEvent> => {
      throw new Error("llm boom");
    };
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    expect(h.sent.find((m) => m.type === "error")).toMatchObject({ code: "llm_failed", fatal: false });
    const hold = h.sent.find(
      (m) => m.type === "agent.text" && (m as { blockId?: string }).blockId === "hold",
    );
    expect(hold).toBeDefined();
    await h.session.handleMessage({ type: "playback.done", utteranceId: "hold" });
    expect(h.session.currentState).toBe("listening");
  });

  it("B1: a notice-stage failure ends the session, never hold+listen", async () => {
    const h = makeHarness();
    // The notice render fails (e.g. vendor 429/5xx), including the background prerender.
    const render = h.blocks.render.bind(h.blocks);
    vi.spyOn(h.blocks, "render").mockImplementation(
      (block: BlockDefinition, opts: { orgName: string; voiceId: string }) => {
        if (block.id === "recording_notice") return Promise.reject(new Error("tts 429 throttled"));
        return render(block, opts);
      },
    );
    await h.session.handleMessage(START);
    expect(h.session.currentState).toBe("notice");

    await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-disclosure" });

    // No hold audio, no listening: the session is over.
    expect(h.session.currentState).toBe("ended");
    expect(h.closed).toHaveLength(1);
    expect(
      h.sent.find((m) => m.type === "agent.text" && (m as { blockId?: string }).blockId === "hold"),
    ).toBeUndefined();
    expect(states(h)).not.toContain("listening");
    const fatal = h.sent.find((m) => m.type === "error");
    expect(fatal).toMatchObject({ fatal: true });
    // Vendor detail stays server-side (F7).
    expect((fatal as { message?: string }).message ?? "").not.toContain("429");
    const interaction = h.store.interactions.get(h.interactionId());
    expect(interaction?.endReason).toBe("error");
    expect(interaction?.complianceFlags).toEqual(["notice_failed"]);
    expect(h.logs.find((l) => l["msg"] === "compliance.notice_failed")).toMatchObject({
      alert: "compliance_reviewer",
    });
  });

  it("M21: a notice ack timeout flags the interaction and logs an alert", async () => {
    const h = makeHarness({ config: { noticeAckTimeoutMs: 30 } });
    await h.session.handleMessage(START);
    expect(h.session.currentState).toBe("notice");

    await vi.waitFor(() => expect(h.closed).toHaveLength(1));

    expect(h.session.currentState).toBe("ended");
    expect(states(h)).not.toContain("listening");
    const interaction = h.store.interactions.get(h.interactionId());
    expect(interaction?.endReason).toBe("error");
    expect(interaction?.complianceFlags).toEqual(["notice_failed"]);
    expect(interaction?.recordingState).not.toBe("recording");
    expect(h.logs.find((l) => l["msg"] === "compliance.notice_failed")).toMatchObject({
      alert: "compliance_reviewer",
      reason: "notice ack timed out",
    });
  });

  it("F2: an early notice ack is ignored and the timeout keeps running", async () => {
    const h = makeHarness({ blockSeconds: 2, config: { noticeAckTimeoutMs: 60 } });
    await h.session.handleMessage(START);
    expect(h.session.currentState).toBe("notice");

    // Client acks with zero playout wait: must not advance the handshake.
    await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-disclosure" });
    expect(h.session.currentState).toBe("notice");
    expect(h.sent.filter((m) => m.type === "agent.text")).toHaveLength(1);
    expect(h.logs.find((l) => l["msg"] === "session.notice_ack_early")).toMatchObject({
      utteranceId: "notice-disclosure",
      expectedMs: 2000,
    });

    // The notice timeout still fires: fail closed, flagged.
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.store.interactions.get(h.interactionId())?.complianceFlags).toEqual(["notice_failed"]);
    expect(h.store.interactions.get(h.interactionId())?.recordingState).not.toBe("recording");
  });

  it("F2: a notice ack after real playout time is accepted", async () => {
    const h = makeHarness({ blockSeconds: 0.3 });
    await h.session.handleMessage(START);
    // 300 ms block, 250 ms tolerance: ack after 120 ms must pass.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-disclosure" });
    expect(h.sent.filter((m) => m.type === "agent.text")).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await h.session.handleMessage({ type: "playback.done", utteranceId: "notice-notice" });
    expect(h.session.currentState).toBe("listening");
    expect(h.store.interactions.get(h.interactionId())?.recordingState).toBe("recording");
  });

  it("F3: an echoed card number is never spoken or emitted", async () => {
    const h = makeHarness({
      sttFinals: ["My card is 4111 1111 1111 1111."],
      llmReplies: ["Thanks, your card 4111 1111 1111 1111 is noted."],
    });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });

    // TTS never receives the digits.
    expect(h.tts.spoken.join(" ")).not.toContain("4111");
    expect(h.tts.spoken.join(" ")).toContain("your card number");
    // The client transcript never receives the digits either.
    const emitted = h.sent
      .filter((m) => m.type === "agent.text" && (m as { kind: string }).kind === "speech")
      .map((m) => (m as { delta: string }).delta)
      .join("");
    expect(emitted).not.toContain("4111");
    expect(emitted).toContain("your card number");
    // The guardrail trip is logged without values.
    expect(h.logs.find((l) => l["msg"] === "guardrail.speak_policy")).toMatchObject({
      kinds: ["card"],
    });
    // Storage redacts both sides (in-memory store redacts too, M16).
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns[0]?.text).toBe("My card is [CARD].");
    expect(turns[1]?.spokenText).toContain("your card number");
  });

  it("F3: an echoed BVN is never spoken or emitted", async () => {
    const h = makeHarness({
      sttFinals: ["BVN 2212 345 6789."],
      llmReplies: ["Confirming BVN 2212 345 6789 for you."],
    });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });

    expect(h.tts.spoken.join(" ")).not.toContain("2212");
    const emitted = h.sent
      .filter((m) => m.type === "agent.text" && (m as { kind: string }).kind === "speech")
      .map((m) => (m as { delta: string }).delta)
      .join("");
    expect(emitted).not.toContain("2212");
    expect(emitted).toContain("your B V N");
  });

  it("M22: a recording objection stops turn writes but the call continues", async () => {
    const h = makeHarness({
      sttFinals: ["Please do not record this call.", "What is my balance?"],
      llmReplies: ["Recording stopped. How can I help?", "Your balance is ten naira."],
    });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });

    expect(h.logs.find((l) => l["msg"] === "recording.objection")).toMatchObject({
      interactionId: h.interactionId(),
    });
    // The conversation continues (agent audio flows) but nothing is stored.
    expect(h.sent.some((m) => m.type === "agent.audio")).toBe(true);
    expect(h.store.interactions.get(h.interactionId())?.turns).toHaveLength(0);

    await h.session.handleMessage({ type: "input.speech_ended", atMs: 1000 });
    expect(h.store.interactions.get(h.interactionId())?.turns).toHaveLength(0);
    expect(h.session.currentState).toBe("listening");
  });

  it("stores the system prompt version on agent turns", async () => {
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: ["Hello there."] });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.find((t) => t.speaker === "agent")).toMatchObject({ promptVersion: 2 });
    expect(turns.find((t) => t.speaker === "caller")?.promptVersion).toBeUndefined();
  });

  it("M1: speech during the finalize wait starts a fresh turn", async () => {
    const h = makeHarness({
      sttFinals: ["stale turn", "fresh turn"],
      llmReplies: ["Fresh answer here."],
    });
    await completeNotice(h);
    const sttSession = h.stt.sessions[0];
    if (!sttSession) throw new Error("no stt session");
    sttSession.deferred = true;

    const turn1 = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    await vi.waitFor(() => expect(sttSession.parkedFinalizes).toBe(1));
    expect(h.session.currentState).toBe("thinking");

    // Caller speaks again while the server awaits the STT final.
    await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
    expect(h.session.currentState).toBe("listening");

    const turn2 = h.session.handleMessage({ type: "input.speech_ended", atMs: 20 });
    await vi.waitFor(() => expect(sttSession.parkedFinalizes).toBe(1));
    sttSession.release();
    await turn1;
    await turn2;

    // The stale turn is abandoned: exactly one final, the fresh one.
    const finals = h.sent.filter((m) => m.type === "transcript.final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ text: "fresh turn" });
    expect(h.session.currentState).toBe("listening");
  });

  it("M3: a stale playback.interrupted does not kill the current turn", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: ["Hello there friend."], ttsGate: gate });
    await completeNotice(h);
    const turnPromise = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    await vi.waitFor(() => {
      expect(h.sent.some((m) => m.type === "transcript.final")).toBe(true);
    });
    const turnId = currentTurnId(h);
    await vi.waitFor(() => {
      expect(
        h.sent.some((m) => m.type === "agent.audio" && (m as { utteranceId: string }).utteranceId === turnId),
      ).toBe(true);
    });
    // Stale interrupt for a long-gone utterance: must be ignored.
    await h.session.handleMessage({ type: "playback.interrupted", utteranceId: "stale-turn", playedMs: 9999 });
    expect(h.sent.some((m) => m.type === "agent.cancelled")).toBe(false);
    openGate();
    await turnPromise;
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.find((t) => t.speaker === "agent")).toMatchObject({ interrupted: false });
  });

  it("M4: a slow-teardown turn cannot unplug the next turn (abort handover)", async () => {
    let openGate1!: () => void;
    let openGate2!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      openGate1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      openGate2 = resolve;
    });
    const h = makeHarness({
      sttFinals: ["first call", "second call"],
      llmReplies: ["First turn here.", "Second turn here."],
      ttsGateFor: (text) => (text.includes("First") ? gate1 : gate2),
    });
    await completeNotice(h);
    const turn1 = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    await vi.waitFor(() => {
      expect(h.sent.some((m) => m.type === "transcript.final")).toBe(true);
    });
    const turn1Id = currentTurnId(h);
    await vi.waitFor(() => {
      expect(
        h.sent.some((m) => m.type === "agent.audio" && (m as { utteranceId: string }).utteranceId === turn1Id),
      ).toBe(true);
    });
    // Barge turn 1; its TTS stays parked on gate1 (aborted, not released).
    await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
    const turn2 = h.session.handleMessage({ type: "input.speech_ended", atMs: 20 });
    await vi.waitFor(() => {
      expect(h.sent.filter((m) => m.type === "transcript.final")).toHaveLength(2);
    });
    const finals = h.sent.filter((m) => m.type === "transcript.final");
    const last = finals[finals.length - 1];
    if (last?.type !== "transcript.final") throw new Error("no second final");
    const turn2Id = last.turnId;
    await vi.waitFor(() => {
      expect(
        h.sent.some((m) => m.type === "agent.audio" && (m as { utteranceId: string }).utteranceId === turn2Id),
      ).toBe(true);
    });
    // Turn 1's teardown lands AFTER turn 2 assigned fresh controllers...
    openGate1();
    await turn1;
    // ...so barging turn 2 must still cancel its TTS.
    await h.session.handleMessage({ type: "playback.interrupted", utteranceId: turn2Id, playedMs: 10 });
    openGate2();
    await turn2;
    expect(h.tts.ttsSession.abortedContexts).toContain(`${turn2Id}:s0`);
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.filter((t) => t.speaker === "agent")).toHaveLength(2);
    expect(turns.filter((t) => t.speaker === "agent").every((t) => t.interrupted)).toBe(true);
  });

  it("M5: a playout-tail barge cancels audio and truncates history", async () => {
    const sentence = "Hello there friend.";
    const canned = new Map<string, FakeUtterance>([
      [
        sentence,
        {
          pcm: makePcm(1.2),
          words: [
            { text: "Hello", startS: 0, endS: 0.4, confidence: null },
            { text: "there", startS: 0.4, endS: 0.8, confidence: null },
            { text: "friend.", startS: 0.8, endS: 1.2, confidence: null },
          ],
        },
      ],
    ]);
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: [sentence], ttsCanned: canned });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    expect(h.session.currentState).toBe("listening");
    const turnId = currentTurnId(h);

    // All bytes sent, but the client is still playing: interrupt the tail.
    await h.session.handleMessage({ type: "playback.progress", utteranceId: turnId, playedMs: 500 });
    await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
    expect(h.sent).toContainEqual({ type: "agent.cancelled", utteranceId: turnId });

    // Exactly one agent turn stored (no duplicate), history keeps "Hello".
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.filter((t) => t.speaker === "agent")).toHaveLength(1);
    h.stt.sessions[0]?.finals.push("Thanks.");
    h.llm.replies.push("You are welcome.");
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 20 });
    const lastMessages = h.llm.seenMessages[h.llm.seenMessages.length - 1] ?? [];
    expect(lastMessages.filter((m) => m.role === "assistant")).toEqual([
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("M5: an acked turn is not barged again", async () => {
    const h = makeHarness({ sttFinals: ["Hi.", "Again."], llmReplies: ["Hello.", "Hi again."] });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    const turnId = currentTurnId(h);
    await h.session.handleMessage({ type: "playback.done", utteranceId: turnId });
    await h.session.handleMessage({ type: "playback.done", utteranceId: turnId });
    // Speaking now starts a clean turn: no spurious cancel for the old one.
    await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
    expect(h.sent.some((m) => m.type === "agent.cancelled")).toBe(false);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 20 });
    expect(h.session.currentState).toBe("listening");
  });

  it("barging the hold block stops it without storing a turn", async () => {
    const h = makeHarness({ sttFinals: ["Hello?"] });
    const broken = h.llm as unknown as { streamChat: () => AsyncIterable<LlmEvent> };
    broken.streamChat = (): AsyncIterable<LlmEvent> => {
      throw new Error("llm boom");
    };
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    expect(h.session.currentState).toBe("speaking");
    await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
    expect(h.sent).toContainEqual({ type: "agent.cancelled", utteranceId: "hold" });
    expect(h.session.currentState).toBe("listening");
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.filter((t) => t.speaker === "agent")).toHaveLength(0);
  });

  it("M27: the LLM stream is not backpressured by slow TTS (order kept)", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const h = makeHarness({
      sttFinals: ["Hi."],
      llmReplies: ["First sentence here. Second sentence here."],
      ttsGate: gate,
    });
    await completeNotice(h);
    const turn = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    // The LLM run completes while TTS for sentence 1 is still parked...
    await vi.waitFor(() => expect(h.llm.finishedReplies).toHaveLength(1));
    // ...and sentence 2 has not started speaking yet (ordered queue).
    expect(h.tts.spoken).toEqual(["First sentence here."]);
    openGate();
    await turn;
    // ...and audio still comes out in sentence order.
    expect(h.tts.spoken).toEqual(["First sentence here.", "Second sentence here."]);
    expect(h.session.currentState).toBe("listening");
  });

  it("M28: TTS starts on the first sentence while the LLM is stalled", async () => {
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const h = makeHarness({
      sttFinals: ["Hi."],
      llmReplies: ["Hello there. Second part here."],
    });
    h.llm.barrier = { afterWords: 1, gate: barrier };
    await completeNotice(h);
    const turn = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    await vi.waitFor(() => {
      expect(h.sent.some((m) => m.type === "transcript.final")).toBe(true);
    });
    const turnId = currentTurnId(h);
    // The stream stalls after "there." (no lookahead): the idle flush speaks
    // sentence 1 without waiting for the rest of the stream.
    await vi.waitFor(() => {
      expect(
        h.sent.some((m) => m.type === "agent.audio" && (m as { utteranceId: string }).utteranceId === turnId),
      ).toBe(true);
    });
    expect(h.tts.spoken).toEqual(["Hello there."]);
    openBarrier();
    await turn;
    expect(h.tts.spoken).toEqual(["Hello there.", "Second part here."]);
    expect(h.session.currentState).toBe("listening");
  });

  it("M29: the caller-turn write runs off the first-audio path", async () => {
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: ["Hello there."] });
    await completeNotice(h);
    let releaseCaller!: () => void;
    const callerGate = new Promise<void>((resolve) => {
      releaseCaller = resolve;
    });
    const origAppend = h.store.appendTurn.bind(h.store);
    const order: string[] = [];
    vi.spyOn(h.store, "appendTurn").mockImplementation(async (tenantId, turn) => {
      if (turn.speaker === "caller") await callerGate;
      order.push(turn.speaker);
      return origAppend(tenantId, turn);
    });
    const turn = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    // The LLM pipeline starts while the caller write is still parked...
    await vi.waitFor(() => expect(h.llm.seenMessages).toHaveLength(1));
    releaseCaller();
    await turn;
    // ...and the caller write still lands before the agent write.
    expect(order).toEqual(["caller", "agent"]);
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.map((t) => t.seq)).toEqual([1, 2]);
  });

  it("M30: the TTS connect overlaps the disclosure render", async () => {
    const h = makeHarness();
    const renders: string[] = [];
    const origRender = h.blocks.render.bind(h.blocks);
    vi.spyOn(h.blocks, "render").mockImplementation(async (block, opts) => {
      renders.push(block.id);
      return origRender(block, opts);
    });
    let openTts!: () => void;
    h.tts.startGate = new Promise<void>((resolve) => {
      openTts = resolve;
    });
    const starting = h.session.handleMessage(START);
    // The disclosure render starts while the TTS connect is still pending.
    await vi.waitFor(() => expect(renders).toContain("disclose_ai"));
    expect(h.tts.startEntered).toBe(true);
    openTts();
    await starting;
    expect(h.session.currentState).toBe("notice");
  });

  it("M30: session start does not wait for the STT connect", async () => {
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: ["Hello."] });
    let openStt!: () => void;
    h.stt.startGate = new Promise<void>((resolve) => {
      openStt = resolve;
    });
    await completeNotice(h);
    expect(h.session.currentState).toBe("listening");
    // The first turn parks on STT readiness, then proceeds once connected.
    const turn = h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.llm.seenMessages).toHaveLength(0);
    openStt();
    await turn;
    expect(h.sent.filter((m) => m.type === "transcript.final")).toHaveLength(1);
    expect(h.session.currentState).toBe("listening");
  });

  it("M31: llm_total excludes TTS; the TTS span is recorded separately", async () => {
    const h = makeHarness({ sttFinals: ["Hi."], llmReplies: ["Hello there."], ttsSpeakDelayMs: 200 });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 0 });
    const metrics = h.sent.find((m) => m.type === "turn.metrics");
    expect(metrics?.type).toBe("turn.metrics");
    if (metrics?.type !== "turn.metrics") throw new Error("no metrics");
    expect(metrics.timingsMs.llm_total).toBeLessThan(200);
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns.find((t) => t.speaker === "agent")?.timingsMs.tts_total).toBeGreaterThanOrEqual(150);
    expect(h.logs.find((l) => l["msg"] === "turn.completed")).toMatchObject({
      tts_total_ms: expect.any(Number),
    });
  });

  it("prompts on silence, then ends the session", async () => {
    const h = makeHarness({ config: { silencePromptAfterMs: 30, silenceEndAfterMs: 40 } });
    await completeNotice(h);
    await vi.waitFor(() => {
      const prompt = h.sent.find(
        (m) => m.type === "agent.text" && (m as { blockId?: string }).blockId === "silence_prompt",
      );
      expect(prompt).toBeDefined();
    });
    await h.session.handleMessage({ type: "playback.done", utteranceId: "silence-prompt" });
    expect(h.session.currentState).toBe("listening");
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.store.interactions.get(h.interactionId())?.endReason).toBe("timeout");
  });

  it("ends the session after maxTurns agent turns (F4)", async () => {
    const h = makeHarness({
      sttFinals: ["first question.", "second question."],
      llmReplies: ["First answer.", "Second answer."],
      config: { maxTurns: 1 },
    });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
    expect(h.llm.seenMessages).toHaveLength(1);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 200 });
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.closed[0]).toMatchObject({ code: 1000, reason: "agent_ended" });
    expect(h.llm.seenMessages).toHaveLength(1);
    const fatal = h.sent.find((m) => m.type === "error" && (m as { fatal?: boolean }).fatal === true);
    expect(fatal).toMatchObject({ code: "internal" });
    expect(h.logs.some((l) => l.msg === "session.turns_capped")).toBe(true);
  });

  it("drops turn audio past maxTurnAudioS but keeps the session (F4)", async () => {
    const h = makeHarness({
      sttFinals: ["short question."],
      llmReplies: ["Short answer."],
      config: { maxTurnAudioS: 1 },
    });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_started", atMs: 0 });
    h.session.handleAudio(Buffer.alloc(32000));
    h.session.handleAudio(Buffer.alloc(640));
    expect(h.stt.sessions[0]?.audioBytes).toBe(32000);
    expect(h.closed).toHaveLength(0);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
    expect(h.session.currentState).toBe("listening");
    expect(h.logs.some((l) => l.msg === "session.turn_audio_capped")).toBe(true);
  });

  it("ends the session at maxSessionS (F4)", async () => {
    const h = makeHarness({ config: { maxSessionS: 1 } });
    await completeNotice(h);
    await vi.waitFor(() => expect(h.closed).toHaveLength(1), { timeout: 5000 });
    expect(h.closed[0]).toMatchObject({ code: 1000, reason: "agent_ended" });
    expect(h.logs.some((l) => l.msg === "session.duration_capped")).toBe(true);
  }, 10000);

  it("drops inbound audio over the bytes/sec budget, ends on sustained flood (F4)", async () => {
    const h = makeHarness({ config: { maxBytesPerSec: 640 } });
    await completeNotice(h);
    h.session.handleAudio(Buffer.alloc(640));
    h.session.handleAudio(Buffer.alloc(640));
    expect(h.stt.sessions[0]?.audioBytes).toBe(640);
    expect(h.closed).toHaveLength(0);
    // Sustained flood (>3s-equivalent dropped) ends the session.
    for (let i = 0; i < 5; i += 1) h.session.handleAudio(Buffer.alloc(640));
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    expect(h.closed[0]).toMatchObject({ reason: "agent_ended" });
    expect(h.logs.some((l) => l.msg === "session.audio_flood")).toBe(true);
  });

  it("F7: fallback failure sends a generic fatal, vendor detail stays server-side", async () => {
    const h = makeHarness({ sttFinals: ["hello?"], llmReplies: ["Hi."] });
    await completeNotice(h);
    // The LLM blows up mid-turn and the hold-block render fails too.
    vi.spyOn(h.llm, "streamChat").mockImplementation(async function* () {
      throw new Error("meta 500 quota exploded");
      yield { kind: "delta", text: "unreached" } as never;
    });
    const render = h.blocks.render.bind(h.blocks);
    vi.spyOn(h.blocks, "render").mockImplementation(
      (block: BlockDefinition, opts: { orgName: string; voiceId: string }) => {
        if (block.id === "hold") return Promise.reject(new Error("cartesia 503 overloaded"));
        return render(block, opts);
      },
    );
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
    await vi.waitFor(() => expect(h.closed).toHaveLength(1));
    const fatal = h.sent.find((m) => m.type === "error" && (m as { fatal?: boolean }).fatal === true);
    expect(fatal).toMatchObject({ fatal: true, code: "internal" });
    const message = (fatal as { message?: string }).message ?? "";
    expect(message).not.toContain("quota");
    expect(message).not.toContain("503");
    expect(message).not.toContain("cartesia");
    expect(h.logs.find((l) => l.msg === "session.fallback_failed")).toMatchObject({
      error: expect.stringContaining("503"),
    });
  });

  it("truncates long transcripts for the LLM but stores the full text (F4)", async () => {
    const long = "word ".repeat(600);
    const h = makeHarness({
      sttFinals: [long],
      llmReplies: ["Noted."],
      config: { maxTranscriptChars: 100 },
    });
    await completeNotice(h);
    await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
    const userMsg = h.llm.seenMessages[0]?.find((m) => m.role === "user");
    expect(userMsg?.content).toHaveLength(100);
    const turns = h.store.interactions.get(h.interactionId())?.turns ?? [];
    expect(turns[0]?.text).toBe(long.trim());
    const final = h.sent.find((m) => m.type === "transcript.final");
    expect(final).toMatchObject({ text: long.trim() });
    expect(h.logs.some((l) => l.msg === "session.transcript_capped")).toBe(true);
  });

  describe("silence window (heard-anchored)", () => {
    const SENTENCE = "Hello there friend.";
    /** Must match the implementation's backstop margin after the sent audio duration. */
    const BACKSTOP_MARGIN_MS = 3000;

    function hasSilencePrompt(h: Harness): boolean {
      return h.sent.some(
        (m) => m.type === "agent.text" && (m as { blockId?: string }).blockId === "silence_prompt",
      );
    }

    function makeSilenceHarness(audioSeconds: number, sttFinals: string[] = ["Hi."]): Harness {
      const canned = new Map<string, FakeUtterance>([
        [SENTENCE, { pcm: makePcm(audioSeconds), words: [] }],
      ]);
      return makeHarness({
        sttFinals,
        llmReplies: [SENTENCE],
        ttsCanned: canned,
        config: { silencePromptAfterMs: 8000, silenceEndAfterMs: 20000 },
      });
    }

    /** Run one caller turn through send-complete; returns the fake-time turn start. */
    async function runTurn(h: Harness): Promise<number> {
      const turnStart = Date.now();
      await h.session.handleMessage({ type: "input.speech_started", atMs: 0 });
      const turnDone = h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
      await vi.advanceTimersByTimeAsync(2000);
      await turnDone;
      expect(h.session.currentState).toBe("listening");
      return turnStart;
    }

    it("no prompt while the reply is unacked past send+8s; prompt 8s after playback.done", async () => {
      vi.useFakeTimers();
      try {
        const h = makeSilenceHarness(8);
        await completeNotice(h);
        await runTurn(h);
        const turnId = currentTurnId(h);
        // Send-complete was during the 2s pipeline advance, so this is 8-10s
        // after send: past the 8s mark, still unacked. No prompt.
        await vi.advanceTimersByTimeAsync(8000);
        expect(hasSilencePrompt(h)).toBe(false);
        // Caller hears the end now: the 8s window starts here.
        await h.session.handleMessage({ type: "playback.done", utteranceId: turnId });
        await vi.advanceTimersByTimeAsync(7900);
        expect(hasSilencePrompt(h)).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(hasSilencePrompt(h)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("long reply (12s): never prompts during playout, never clobbers the turn id", async () => {
      vi.useFakeTimers();
      try {
        const h = makeSilenceHarness(12);
        await completeNotice(h);
        await runTurn(h);
        const turnId = currentTurnId(h);
        // 8-10s after send, reply still playing: no prompt.
        await vi.advanceTimersByTimeAsync(8000);
        expect(hasSilencePrompt(h)).toBe(false);
        // 12-14s after send, still unacked: no prompt (backstop is 12s+3s).
        await vi.advanceTimersByTimeAsync(4000);
        expect(hasSilencePrompt(h)).toBe(false);
        // Tail barge-in still cancels the turn itself, not a clobbered id.
        await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
        expect(h.sent).toContainEqual({ type: "agent.cancelled", utteranceId: turnId });
        expect(hasSilencePrompt(h)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("missing playback.done: backstop starts the 8s window at duration+margin", async () => {
      vi.useFakeTimers();
      try {
        const audioSeconds = 8;
        const h = makeSilenceHarness(audioSeconds);
        await completeNotice(h);
        const turnStart = await runTurn(h);
        // Send-complete t is in [turnStart, turnStart+2000]. Backstop fires at
        // t+11000, prompt at t+19000. At turnStart+18900 neither has fired late:
        // the prompt must still be absent...
        await vi.advanceTimersByTimeAsync(turnStart + 18900 - Date.now());
        expect(hasSilencePrompt(h)).toBe(false);
        // ...but the backstop must have fired (it retires the unacked audio and
        // starts the normal window, logging its use).
        expect(h.logs.some((l) => l["msg"] === "silence.playback_backstop_used")).toBe(true);
        // ...and the prompt follows a full 8s window after the backstop.
        await vi.advanceTimersByTimeAsync(turnStart + 22000 - Date.now());
        expect(hasSilencePrompt(h)).toBe(true);
        expect(BACKSTOP_MARGIN_MS).toBe(3000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("barge-in followed by a long caller utterance is never talked over", async () => {
      vi.useFakeTimers();
      try {
        const h = makeSilenceHarness(8);
        await completeNotice(h);
        await runTurn(h);
        // Tail barge-in: the caller starts speaking while the reply plays.
        await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
        // Caller keeps speaking for 10s (no speech_ended yet): no prompt.
        await vi.advanceTimersByTimeAsync(10000);
        expect(hasSilencePrompt(h)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("speech_started during the silence window cancels it", async () => {
      vi.useFakeTimers();
      try {
        const h = makeSilenceHarness(8);
        await completeNotice(h);
        await runTurn(h);
        const turnId = currentTurnId(h);
        await h.session.handleMessage({ type: "playback.done", utteranceId: turnId });
        await vi.advanceTimersByTimeAsync(4000);
        await h.session.handleMessage({ type: "input.speech_started", atMs: 10 });
        await vi.advanceTimersByTimeAsync(10000);
        expect(hasSilencePrompt(h)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("notice idle prompt and prompt 20s end are unchanged (fake timers)", async () => {
      vi.useFakeTimers();
      try {
        const h = makeHarness({ config: { silencePromptAfterMs: 8000, silenceEndAfterMs: 20000 } });
        await completeNotice(h);
        await vi.advanceTimersByTimeAsync(8000);
        expect(hasSilencePrompt(h)).toBe(true);
        await h.session.handleMessage({ type: "playback.done", utteranceId: "silence-prompt" });
        expect(h.session.currentState).toBe("listening");
        await vi.advanceTimersByTimeAsync(19900);
        expect(h.closed).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(h.closed).toHaveLength(1);
        expect(h.store.interactions.get(h.interactionId())?.endReason).toBe("timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("empty-transcript speech_ended still arms the silence window", async () => {
      vi.useFakeTimers();
      try {
        const h = makeHarness({
          sttFinals: ["  "],
          config: { silencePromptAfterMs: 8000, silenceEndAfterMs: 20000 },
        });
        await completeNotice(h);
        await h.session.handleMessage({ type: "input.speech_started", atMs: 0 });
        await h.session.handleMessage({ type: "input.speech_ended", atMs: 100 });
        expect(h.session.currentState).toBe("listening");
        await vi.advanceTimersByTimeAsync(7900);
        expect(hasSilencePrompt(h)).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(hasSilencePrompt(h)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

function currentTurnId(h: Harness): string {
  const final = h.sent.find((m) => m.type === "transcript.final");
  if (final?.type !== "transcript.final") throw new Error("no transcript.final yet");
  return final.turnId;
}

describe("truncateSpoken", () => {
  const sentences = [
    { sentence: "Hello there.", audioBytes: 9600, durationS: 0.2, words: [] as WordTiming[] },
    {
      sentence: "How can I help you today?",
      audioBytes: 96000,
      durationS: 2.0,
      words: [
        { text: "How", startS: 0, endS: 0.3, confidence: null },
        { text: "can", startS: 0.3, endS: 0.6, confidence: null },
        { text: "I", startS: 0.6, endS: 0.9, confidence: null },
      ],
    },
  ];

  it("keeps whole sentences and truncates the partial one by word timestamps", () => {
    // 200 ms (first sentence) + 650 ms into the second: "How can".
    expect(truncateSpoken(sentences, 850)).toBe("Hello there. How can");
  });

  it("returns everything when the full utterance was heard", () => {
    expect(truncateSpoken(sentences, 5000)).toBe("Hello there. How can I help you today?");
  });

  it("drops the partial sentence without word timestamps", () => {
    const noWords = sentences.map((s) => ({ ...s, words: [] }));
    expect(truncateSpoken(noWords, 850)).toBe("Hello there.");
  });

  it("returns empty when nothing was heard", () => {
    expect(truncateSpoken(sentences, 0)).toBe("");
  });
});
