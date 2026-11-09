import { Inject, Injectable } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";

import { resolveDevPrincipal } from "../auth/dev-auth";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { INTERACTION_STORE, type InteractionStore } from "../interactions/interaction-store";
import { OpenAiCompatibleLlm } from "./adapters/llm/openai-compatible-llm";
import { CartesiaStt } from "./adapters/stt/cartesia-stt";
import { CartesiaTts } from "./adapters/tts/cartesia-tts";
import { BlockRenderer } from "./blocks/block-cache";
import { parseClientMessage } from "./client-messages";
import type { ServerMessage } from "./protocol";
import { DEFAULT_VOICE_SESSION_CONFIG, VoiceSession } from "./voice-session";

/** Close codes in the 4xxx application range (must stay within 4000-4999). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;

/** Largest accepted client frame: JSON text or one PCM chunk. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** PCM frames must be whole 16-bit samples; 100 ms at 16 kHz is 3200 bytes. */
const MAX_PCM_BYTES = 64 * 1024;
/** Concurrent voice sessions per tenant. */
const MAX_SESSIONS_PER_TENANT = 5;

/**
 * WebSocket gateway for the realtime voice loop at `/v1/voice`.
 * The socket is closed immediately (4401/4403) unless the Origin is
 * allow-listed and `?token=` resolves to a dev principal.
 */
@Injectable()
@WebSocketGateway({ path: "/v1/voice", maxPayload: MAX_MESSAGE_BYTES })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly sessions = new Map<WebSocket, VoiceSession>();
  private readonly tenantBySocket = new Map<WebSocket, string>();
  private readonly sessionsPerTenant = new Map<string, number>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(INTERACTION_STORE) private readonly store: InteractionStore,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const origin = request.headers.origin ?? "";
    if (!this.env.ALLOWED_ORIGINS.includes(origin)) {
      socket.close(CLOSE_FORBIDDEN, "origin not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://voice.local");
    const principal = resolveDevPrincipal(url.searchParams.get("token"), this.env);
    if (!principal) {
      socket.close(CLOSE_UNAUTHORIZED, "invalid token");
      return;
    }
    const tenantSessions = this.sessionsPerTenant.get(principal.tenantId) ?? 0;
    if (tenantSessions >= MAX_SESSIONS_PER_TENANT) {
      socket.close(CLOSE_FORBIDDEN, "too many sessions");
      return;
    }
    this.sessionsPerTenant.set(principal.tenantId, tenantSessions + 1);
    this.tenantBySocket.set(socket, principal.tenantId);

    const session = new VoiceSession({
      tenantId: principal.tenantId,
      store: this.store,
      stt: new CartesiaStt({
        apiKey: this.env.CARTESIA_API_KEY,
        version: this.env.CARTESIA_VERSION,
        model: this.env.STT_MODEL,
      }),
      tts: new CartesiaTts({
        apiKey: this.env.CARTESIA_API_KEY,
        version: this.env.CARTESIA_VERSION,
        model: this.env.TTS_MODEL,
        defaultVoiceId: this.env.TTS_VOICE,
      }),
      llm: new OpenAiCompatibleLlm({
        baseUrl: this.env.LLM_BASE_URL,
        apiKey: this.env.MUSE_API_KEY,
        model: this.env.LLM_MODEL,
        reasoningEffort: this.env.LLM_REASONING_EFFORT,
        maxCompletionTokens: this.env.LLM_MAX_COMPLETION_TOKENS,
      }),
      blocks: new BlockRenderer(
        new CartesiaTts({
          apiKey: this.env.CARTESIA_API_KEY,
          version: this.env.CARTESIA_VERSION,
          model: this.env.TTS_MODEL,
          defaultVoiceId: this.env.TTS_VOICE,
        }),
        join(__dirname, "..", "..", ".cache", "blocks"),
      ),
      config: { ...DEFAULT_VOICE_SESSION_CONFIG, defaultVoiceId: this.env.TTS_VOICE },
      send: (message: ServerMessage) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close: (code: number, reason: string) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(code, reason);
        }
      },
      log: (fields: Record<string, unknown>) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "INFO",
            service: "voice-gateway",
            tenant_id: principal.tenantId,
            ...fields,
          }),
        );
      },
    });
    this.sessions.set(socket, session);
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      void this.handleSocketMessage(socket, session, data, isBinary);
    });
  }

  async handleDisconnect(socket: WebSocket): Promise<void> {
    const session = this.sessions.get(socket);
    this.sessions.delete(socket);
    const tenantId = this.tenantBySocket.get(socket);
    this.tenantBySocket.delete(socket);
    if (tenantId) {
      const count = this.sessionsPerTenant.get(tenantId) ?? 0;
      if (count <= 1) this.sessionsPerTenant.delete(tenantId);
      else this.sessionsPerTenant.set(tenantId, count - 1);
    }
    if (session) await session.handleTransportClose();
  }

  private async handleSocketMessage(
    socket: WebSocket,
    session: VoiceSession,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      socket.close(1009, "message too large");
      return;
    }
    if (isBinary) {
      if (bytes.length % 2 !== 0 || bytes.length === 0 || bytes.length > MAX_PCM_BYTES) {
        socket.close(1003, "invalid audio frame");
        return;
      }
      session.handleAudio(bytes);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      this.sendError(socket, "Invalid JSON.");
      return;
    }
    try {
      await session.handleMessage(parseClientMessage(raw));
    } catch {
      this.sendError(socket, "Message failed validation.");
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "error", code: "bad_message", message, fatal: false }));
    }
  }
}
