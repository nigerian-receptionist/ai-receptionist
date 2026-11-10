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
  constructor(finals: string[]) {
    this.finals = [...finals];
  }
  sendAudio(pcm: Buffer): void {
    this.audioBytes += pcm.length;
  }
  onEvent(_listener: (event: SttEvent) => void): void {
    // Partial events are not exercised here.
  }
  async finalize(): Promise<SttResult> {
    const text = this.finals.shift() ?? "";
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
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeStt implements SpeechToText {
  readonly modelId = "stt_fake@test";
  sessions: FakeSttSession[] = [];
  constructor(private readonly finals: string[]) {}
  async startSession(): Promise<SttStreamSession> {
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
  /**
   * text -> canned audio; default one chunk per sentence. When `gate` is set,
   * speak parks after the first audio chunk until the gate opens, so tests can
   * interrupt deterministically mid-utterance.
   */
  constructor(
    private readonly canned: Map<string, FakeUtterance> = new Map(),
    private gate: Promise<void> | null = null,
  ) {}
  async *speak(
    text: string,
    opts: { contextId: string; signal?: AbortSignal },
  ): AsyncIterable<TtsStreamEvent> {
    const found = this.canned.get(text);
    const pcm = found?.pcm ?? makePcm(0.3);
    const words = found?.words ?? [];
    yield { kind: "audio", chunk: { pcmS16le: pcm, sampleRate: 24000, isFirst: true, isLast: true } };
    if (opts.signal?.aborted) throw aborted();
    await tick();
    if (words.length > 0) yield { kind: "timestamps", words };
    if (opts.signal?.aborted) throw aborted();
    if (this.gate) await this.gate;
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
  }
  async close(): Promise<void> {}
}

class FakeTts implements TextToSpeech {
  readonly modelId = "tts_fake@test";
  readonly spoken: string[] = [];
  readonly ttsSession: FakeTtsSession;
  constructor(canned: Map<string, FakeUtterance> = new Map(), gate: Promise<void> | null = null) {
    this.ttsSession = new FakeTtsSession(canned, gate);
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
    const pcm = makePcm(0.5);
    return {
      pcmS16le: pcm,
      sampleRate: 24000,
      durationS: 0.5,
      timeToFirstAudioS: 0.01,
      totalLatencyS: 0.02,
      voiceId: "fake-voice",
      modelId: this.modelId,
      textSpoken: text,
      words: [],
    };
  }
  async startSession(): Promise<TtsStreamSession> {
    return this.ttsSession;
  }
}

class FakeLlm implements LlmClient {
  readonly model = "llm_fake@test";
  readonly seenMessages: ChatMessage[][] = [];
  constructor(readonly replies: string[]) {}
  async *streamChat(messages: ChatMessage[], opts: { signal?: AbortSignal }): AsyncIterable<LlmEvent> {
    this.seenMessages.push(messages);
    const reply = this.replies.shift() ?? "Okay.";
    for (const word of reply.split(" ")) {
      if (opts.signal?.aborted) throw aborted();
      await tick();
      if (opts.signal?.aborted) throw aborted();
      yield { kind: "delta", text: `${word} ` };
    }
    yield { kind: "usage", usage: { in: 10, out: 5, reasoning: 2 } };
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
  llm: FakeLlm;
  blocks: BlockRenderer;
  interactionId: () => string;
}

function makeHarness(opts: {
  sttFinals?: string[];
  llmReplies?: string[];
  ttsCanned?: Map<string, FakeUtterance>;
  ttsGate?: Promise<void> | null;
  config?: Partial<VoiceSessionConfig>;
} = {}): Harness {
  const sent: ServerMessage[] = [];
  const closed: { code: number; reason: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const store = new InMemoryInteractionStore();
  const stt = new FakeStt(opts.sttFinals ?? []);
  const tts = new FakeTts(opts.ttsCanned, opts.ttsGate ?? null);
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
