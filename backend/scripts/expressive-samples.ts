/**
 * Render expressive sample replies as WAV for human listening
 * (`pnpm voice:expressive-samples`).
 *
 * Each sample is written so its emotion matches the content (Cartesia ignores
 * emotions that contradict the transcript). The opener blocks render with
 * their category tones, and the script reports whether each stays under the
 * ~1.2 s opener budget.
 *
 * Output: voice-lab/results/raw/expressive-samples/*.wav (gitignored).
 * Never prints secrets: only names, tones, durations and paths.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "../src/config/env";
import { CartesiaTts } from "../src/voice/adapters/tts/cartesia-tts";
import { OPENERS } from "../src/voice/openers";

const SAMPLES: Array<{ name: string; tone: string; text: string }> = [
  {
    name: "empathetic",
    tone: "empathetic",
    text: "I'm so sorry to hear that. Let me help you sort this out right away.",
  },
  {
    name: "upbeat",
    tone: "upbeat",
    text: "Wonderful news! Your payment went through successfully.",
  },
  {
    name: "calm-firm",
    tone: "calm-firm",
    text: "I understand, but I'll need your full name before I can share any details.",
  },
];

/** Opener budget: each opener must stay under ~1.2 s of audio. */
const OPENER_BUDGET_S = 1.2;

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const tts = new CartesiaTts({
    apiKey: env.CARTESIA_API_KEY,
    version: env.CARTESIA_VERSION,
    model: env.TTS_MODEL,
    defaultVoiceId: env.TTS_VOICE,
  });
  const dir = join(process.cwd(), "..", "voice-lab", "results", "raw", "expressive-samples");
  mkdirSync(dir, { recursive: true });
  console.log(`[samples] model=${env.TTS_MODEL} voice=seun out=${dir}`);

  // Sequential REST calls stay under the 2-concurrent limit.
  for (const sample of SAMPLES) {
    const result = await tts.synthesize(sample.text, {
      voiceId: env.TTS_VOICE,
      language: "en",
      tone: sample.tone,
      sampleRate: 24000,
    });
    const path = join(dir, `reply_${sample.name}.wav`);
    writeFileSync(path, pcmToWav(result.pcmS16le, result.sampleRate));
    console.log(
      `[samples] reply_${sample.name}.wav tone=${sample.tone} duration=${result.durationS.toFixed(2)}s`,
    );
  }

  let overBudget = 0;
  for (const options of Object.values(OPENERS)) {
    for (const option of options) {
      const result = await tts.synthesize(option.block.template, {
        voiceId: env.TTS_VOICE,
        language: option.block.language,
        tone: option.tone,
        sampleRate: 24000,
      });
      const path = join(dir, `${option.block.id}.wav`);
      writeFileSync(path, pcmToWav(result.pcmS16le, result.sampleRate));
      const ok = result.durationS <= OPENER_BUDGET_S;
      if (!ok) overBudget += 1;
      console.log(
        `[samples] ${option.block.id}.wav tone=${option.tone} ` +
          `duration=${result.durationS.toFixed(2)}s ${ok ? "<= 1.2s OK" : "> 1.2s OVER"}`,
      );
    }
  }
  if (overBudget > 0) {
    console.error(`[samples] FAIL: ${overBudget} opener(s) over the 1.2 s budget`);
    process.exit(1);
  }
  console.log("[samples] PASS");
}

main().catch((error: unknown) => {
  console.error(`[samples] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
