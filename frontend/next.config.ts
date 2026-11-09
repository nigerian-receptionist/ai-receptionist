import type { NextConfig } from "next";

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
        ],
      },
    ];
  },
};

export default nextConfig;
