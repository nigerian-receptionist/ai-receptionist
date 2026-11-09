import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TextToSpeech } from "../adapters/types";
import { normaliseForSpeech } from "../normalise";

/**
 * Pre-rendered approved audio blocks (AGENTS.md 5.7): the AI disclosure, the
 * recording notice, and fixed fallback/silence lines. Rendered once per
 * (text, language, voice, model, speed, tone) and cached as raw PCM on disk.
 */

export interface BlockDefinition {
  id: string;
  version: number;
  language: string;
  /** Template; `{org_name}` is substituted at render time. */
  template: string;
}

export const DISCLOSE_AI_BLOCK: BlockDefinition = {
  id: "disclose_ai",
  version: 1,
  language: "en",
  template: "Hello, this is an AI assistant for {org_name}.",
};

export const RECORDING_NOTICE_BLOCK: BlockDefinition = {
  id: "recording_notice",
  version: 1,
  language: "en",
  template: "This call is recorded for improvement purposes.",
};

export const HOLD_BLOCK: BlockDefinition = {
  id: "hold",
  version: 1,
  language: "en",
  template: "Sorry, I'm having trouble hearing you. Please hold on.",
};

export const SILENCE_PROMPT_BLOCK: BlockDefinition = {
  id: "silence_prompt",
  version: 1,
  language: "en",
  template: "Hello? Are you still there?",
};

export interface RenderedBlock {
  block: BlockDefinition;
  text: string;
  /** sha256 of (text, language, voice_id, model_id, speed, tone). */
  hash: string;
  pcmS16le: Buffer;
  sampleRate: number;
  durationS: number;
}

export function blockCacheKey(input: {
  text: string;
  language: string;
  voiceId: string;
  modelId: string;
  speed: number;
  tone: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.text,
        input.language,
        input.voiceId,
        input.modelId,
        input.speed,
        input.tone,
      ]),
    )
    .digest("hex");
}

export function renderBlockText(block: BlockDefinition, variables: Record<string, string>): string {
  return block.template.replace(/\{(\w+)\}/g, (_match, name: string) => variables[name] ?? `{${name}}`);
}

export class BlockRenderer {
  private readonly tts: TextToSpeech;
  private readonly cacheDir: string;
  private readonly inFlight = new Map<string, Promise<RenderedBlock>>();

  constructor(tts: TextToSpeech, cacheDir: string) {
    this.tts = tts;
    this.cacheDir = cacheDir;
  }

  async render(
    block: BlockDefinition,
    opts: { orgName: string; voiceId: string; speed?: number; tone?: string },
  ): Promise<RenderedBlock> {
    const text = normaliseForSpeech(renderBlockText(block, { org_name: opts.orgName }));
    const speed = opts.speed ?? 1.0;
    const tone = opts.tone ?? "neutral";
    const hash = blockCacheKey({
      text,
      language: block.language,
      voiceId: opts.voiceId,
      modelId: this.tts.modelId,
      speed,
      tone,
    });
    const cached = this.readCache(hash);
    if (cached) {
      return { block, text, hash, pcmS16le: cached, sampleRate: 24000, durationS: cached.length / 2 / 24000 };
    }
    const existing = this.inFlight.get(hash);
    if (existing) return existing;
    const render = (async (): Promise<RenderedBlock> => {
      const result = await this.tts.synthesize(text, {
        voiceId: opts.voiceId,
        language: block.language,
        tone,
        speed,
      });
      if (result.sampleRate !== 24000) throw new Error(`unexpected block sample rate ${result.sampleRate}`);
      this.writeCache(hash, result.pcmS16le);
      return {
        block,
        text,
        hash,
        pcmS16le: result.pcmS16le,
        sampleRate: result.sampleRate,
        durationS: result.durationS,
      };
    })();
    this.inFlight.set(hash, render);
    try {
      return await render;
    } finally {
      this.inFlight.delete(hash);
    }
  }

  private readCache(hash: string): Buffer | null {
    try {
      const path = join(this.cacheDir, `${hash}.pcm`);
      if (!existsSync(path)) return null;
      return readFileSync(path);
    } catch {
      return null;
    }
  }

  private writeCache(hash: string, pcm: Buffer): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(join(this.cacheDir, `${hash}.pcm`), pcm);
  }
}
