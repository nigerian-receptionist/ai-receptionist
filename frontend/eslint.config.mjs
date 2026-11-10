// Flat ESLint config (`next lint` is deprecated in Next 15). The Next 15.5
// shareable config is still eslintrc-shaped, so it loads via FlatCompat.
import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // AudioWorklet entry: plain browser JS with worklet globals.
    files: ["public/worklets/**/*.js"],
    languageOptions: {
      globals: {
        sampleRate: "readonly",
        AudioWorkletProcessor: "readonly",
        registerProcessor: "readonly",
      },
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "out/**", "public/vad/**", "next-env.d.ts"],
  },
];

export default config;
