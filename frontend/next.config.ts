import type { NextConfig } from "next";

// Origins the talk page may connect to (build-time env, local defaults).
const voiceWsOrigin = originOf(process.env.NEXT_PUBLIC_VOICE_WS_URL, "ws://127.0.0.1:8000");
const apiOrigin = originOf(process.env.NEXT_PUBLIC_API_URL, "http://127.0.0.1:8000");

function originOf(raw: string | undefined, fallback: string): string {
  try {
    return new URL(raw ?? fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
}

// Content Security Policy for the voice lab UI (F8). Notes:
// - `wasm-unsafe-eval` lets the same-origin onnxruntime-web build compile the
//   Silero VAD model without opening full `unsafe-eval`.
// - `worker-src 'self' blob:` covers the VAD audio worklet and the ORT
//   threaded workers. AudioWorklet module fetches are same-origin.
// - `connect-src` allows the voice WebSocket and the API origin from env.
// - Inline scripts: Next.js App Router streams RSC payloads via inline
//   `<script>` tags, so `script-src` keeps `'unsafe-inline'` until a nonce
//   middleware lands. The policy still constrains everything else.
// - COOP/COEP stay: SharedArrayBuffer (crossOriginIsolated) is required by
//   the threaded ORT build.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${voiceWsOrigin} ${apiOrigin}`,
  "worker-src 'self' blob:",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Cross-origin isolation enables SharedArrayBuffer, which the threaded
        // onnxruntime-web build used by /talk VAD requires. Same-origin assets
        // and the voice WebSocket are unaffected.
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ],
      },
    ];
  },
};

export default nextConfig;
