import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TextToSpeech, TtsResult, TtsStreamSession } from "../adapters/types";
import {
  blockCacheKey,
  BlockRenderer,
  DEFAULT_MODEL_REVISION,
  DISCLOSE_AI_BLOCK,
  renderBlockText,
} from "./block-cache";
import { normaliseForSpeech } from "../normalise";

class FakeBlockTts implements TextToSpeech {
  readonly modelId = "tts_fake@test";
  calls = 0;
  pcm = Buffer.alloc(4800);
  rate = 24000;
  seenSampleRate: number | undefined;
  delayMs = 0;

  voices() {
    return [];
  }

  async synthesize(
    text: string,
    opts: { voiceId: string; language: string; sampleRate?: number },
  ): Promise<TtsResult> {
    this.calls += 1;
    this.seenSampleRate = opts.sampleRate;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      pcmS16le: this.pcm,
      sampleRate: this.rate,
      durationS: this.pcm.length / 2 / this.rate,
      timeToFirstAudioS: 0.01,
      totalLatencyS: 0.02,
      voiceId: opts.voiceId,
      modelId: this.modelId,
      textSpoken: text,
      words: [],
    };
  }

  async startSession(): Promise<TtsStreamSession> {
    throw new Error("unused");
  }
}

function hashFor(tts: FakeBlockTts): string {
  const text = normaliseForSpeech(renderBlockText(DISCLOSE_AI_BLOCK, { org_name: "Acme" }));
  return blockCacheKey({
    text,
    language: DISCLOSE_AI_BLOCK.language,
    voiceId: "voice-1",
    modelId: tts.modelId,
    modelRevision: DEFAULT_MODEL_REVISION,
    speed: 1,
    tone: "neutral",
    outputSampleRate: 24000,
  });
}

describe("BlockRenderer", () => {
  it("renders once and serves the rest from cache", async () => {
    const tts = new FakeBlockTts();
    const renderer = new BlockRenderer(tts, mkdtempSync(join(tmpdir(), "blocks-")));
    const first = await renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    const second = await renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    expect(tts.calls).toBe(1);
    expect(first.text).toContain("Acme");
    expect(second.pcmS16le.equals(first.pcmS16le)).toBe(true);
  });

  it("dedups concurrent renders of the same block", async () => {
    const tts = new FakeBlockTts();
    tts.delayMs = 20;
    const renderer = new BlockRenderer(tts, mkdtempSync(join(tmpdir(), "blocks-")));
    const [a, b] = await Promise.all([
      renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" }),
      renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" }),
    ]);
    expect(tts.calls).toBe(1);
    expect(a.hash).toBe(b.hash);
  });

  it("rejects odd-length pcm from synthesis", async () => {
    const tts = new FakeBlockTts();
    tts.pcm = Buffer.alloc(11);
    const renderer = new BlockRenderer(tts, mkdtempSync(join(tmpdir(), "blocks-")));
    await expect(
      renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" }),
    ).rejects.toThrow("even-length");
  });

  it("treats an odd-length cache entry as a miss and re-renders", async () => {
    const tts = new FakeBlockTts();
    const dir = mkdtempSync(join(tmpdir(), "blocks-"));
    const renderer = new BlockRenderer(tts, dir);
    await renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    expect(tts.calls).toBe(1);
    writeFileSync(join(dir, `${hashFor(tts)}.pcm`), Buffer.alloc(11));
    await renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    expect(tts.calls).toBe(2);
  });

  it("keys the cache by exact model id, revision and output sample rate (M18)", () => {
    const base = {
      text: "hello",
      language: "en",
      voiceId: "v",
      modelId: "m",
      speed: 1,
      tone: "neutral",
      modelRevision: "r1",
      outputSampleRate: 24000,
    };
    expect(blockCacheKey({ ...base, modelRevision: "r2" })).not.toBe(blockCacheKey(base));
    expect(blockCacheKey({ ...base, outputSampleRate: 16000 })).not.toBe(blockCacheKey(base));
    // A dated snapshot pin re-renders blocks instead of reusing stale audio.
    expect(blockCacheKey({ ...base, modelId: "tts_cartesia@sonic-3.6-2026-08-27" })).not.toBe(
      blockCacheKey({ ...base, modelId: "tts_cartesia@sonic-3.6" }),
    );
    expect(blockCacheKey(base)).toBe(blockCacheKey({ ...base }));
  });

  it("re-renders when the model revision changes instead of reusing stale audio", async () => {
    const tts = new FakeBlockTts();
    const dir = mkdtempSync(join(tmpdir(), "blocks-"));
    const r1 = new BlockRenderer(tts, dir, { modelRevision: "r1" });
    const first = await r1.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    expect(tts.calls).toBe(1);
    const r2 = new BlockRenderer(tts, dir, { modelRevision: "r2" });
    const second = await r2.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    expect(tts.calls).toBe(2);
    expect(second.hash).not.toBe(first.hash);
  });

  it("requests the configured sample rate and rejects mismatches", async () => {
    const tts = new FakeBlockTts();
    tts.rate = 16000;
    tts.pcm = Buffer.alloc(3200);
    const renderer = new BlockRenderer(tts, mkdtempSync(join(tmpdir(), "blocks-")), {
      outputSampleRate: 16000,
    });
    const rendered = await renderer.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" });
    expect(tts.seenSampleRate).toBe(16000);
    expect(rendered.sampleRate).toBe(16000);

    tts.rate = 24000;
    const renderer2 = new BlockRenderer(new FakeBlockTts(), mkdtempSync(join(tmpdir(), "blocks-")), {
      outputSampleRate: 16000,
    });
    await expect(
      renderer2.render(DISCLOSE_AI_BLOCK, { orgName: "Acme", voiceId: "voice-1" }),
    ).rejects.toThrow("unexpected block sample rate");
  });
});
