import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import WebSocket from "ws";

import { resolveDevPrincipal, type Principal } from "../auth/dev-auth";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { INTERACTION_STORE, type InteractionStore } from "../interactions/interaction-store";
import { OpenAiCompatibleLlm } from "./adapters/llm/openai-compatible-llm";
import { CartesiaStt } from "./adapters/stt/cartesia-stt";
import { CartesiaTts } from "./adapters/tts/cartesia-tts";
import { BlockRenderer } from "./blocks/block-cache";
import { parseClientMessage } from "./client-messages";
import type { ServerMessage } from "./protocol";
import { VOICE_PROTOCOL_VERSION } from "./protocol";
import { DEFAULT_VOICE_SESSION_CONFIG, VoiceSession } from "./voice-session";

/** Close codes in the 4xxx application range (must stay within 4000-4999). */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_SETUP_TIMEOUT = 4408;

/** Largest accepted client frame: JSON text or one PCM chunk. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** PCM frames must be whole 16-bit samples; 100 ms at 16 kHz is 3200 bytes. */
const MAX_PCM_BYTES = 64 * 1024;
/** Concurrent voice sessions per tenant. */
const MAX_SESSIONS_PER_TENANT = 5;
/** A socket that never sends `session.start` is closed after this long. */
const SETUP_TIMEOUT_MS = 30_000;
/** Ping/pong heartbeat period; unresponsive sockets are terminated. */
const HEARTBEAT_MS = 30_000;

/**
 * WebSocket gateway for the realtime voice loop at `/v1/voice`.
 * The socket is closed immediately (4401/4403) unless the Origin is
 * allow-listed and `?token=` resolves to a dev principal.
 */
@Injectable()
@WebSocketGateway({ path: "/v1/voice", maxPayload: MAX_MESSAGE_BYTES })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<WebSocket, VoiceSession>();
  private readonly tenantBySocket = new Map<WebSocket, string>();
  private readonly sessionsPerTenant = new Map<string, number>();
  private readonly setupTimers = new Map<WebSocket, NodeJS.Timeout>();
  private readonly alive = new Map<WebSocket, boolean>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(INTERACTION_STORE) private readonly store: InteractionStore,
  ) {}

  onModuleInit(): void {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const timer of this.setupTimers.values()) clearTimeout(timer);
    this.setupTimers.clear();
  }

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
    this.alive.set(socket, true);
    socket.on("pong", () => this.alive.set(socket, true));

    const session = this.createSession(principal, socket);
    this.sessions.set(socket, session);
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      void this.handleSocketMessage(socket, session, data, isBinary);
    });
    // A socket that never starts would hold a tenant slot forever.
    const timer = setTimeout(() => {
      if (session.currentInteractionId === null) {
        this.log(principal.tenantId, { msg: "gateway.setup_timeout" });
        socket.close(CLOSE_SETUP_TIMEOUT, "session.start not received");
        void this.releaseSocket(socket);
      }
    }, SETUP_TIMEOUT_MS);
    timer.unref?.();
    this.setupTimers.set(socket, timer);
  }

  /** Session factory (overridable in tests to avoid vendor adapters). */
  protected createSession(principal: Principal, socket: WebSocket): VoiceSession {
    return new VoiceSession({
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
        onSkippedPayload: (count) => this.log(principal.tenantId, { msg: "llm.skipped_payloads", count }),
      }),
      blocks: new BlockRenderer(
        new CartesiaTts({
          apiKey: this.env.CARTESIA_API_KEY,
          version: this.env.CARTESIA_VERSION,
          model: this.env.TTS_MODEL,
          defaultVoiceId: this.env.TTS_VOICE,
        }),
        join(__dirname, "..", "..", ".cache", "blocks"),
        { outputSampleRate: this.env.TTS_SAMPLE_RATE, modelRevision: this.env.TTS_MODEL_REVISION },
      ),
      config: {
        ...DEFAULT_VOICE_SESSION_CONFIG,
        defaultVoiceId: this.env.TTS_VOICE,
        outputSampleRate: this.env.TTS_SAMPLE_RATE,
      },
      send: (message: ServerMessage) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close: (code: number, reason: string) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(code, reason);
        }
      },
      log: (fields: Record<string, unknown>) => this.log(principal.tenantId, fields),
    });
  }

  async handleDisconnect(socket: WebSocket): Promise<void> {
    await this.releaseSocket(socket);
  }

  /** Idempotent teardown: timers, maps, slot accounting, transport close. */
  private async releaseSocket(socket: WebSocket): Promise<void> {
    const timer = this.setupTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.setupTimers.delete(socket);
    this.alive.delete(socket);
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

  private checkHeartbeats(): void {
    for (const [socket] of this.sessions) {
      if (this.alive.get(socket) === false) {
        this.log(this.tenantBySocket.get(socket) ?? "unknown", { msg: "gateway.heartbeat_timeout" });
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
        void this.releaseSocket(socket);
      } else {
        this.alive.set(socket, false);
        try {
          socket.ping();
        } catch {
          /* terminate on the next beat */
        }
      }
    }
  }

  private async handleSocketMessage(
    socket: WebSocket,
    session: VoiceSession,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : Buffer.from(data as ArrayBuffer);
    } catch {
      socket.close(1003, "invalid frame");
      return;
    }
    if (bytes.length > MAX_MESSAGE_BYTES) {
      socket.close(1009, "message too large");
      return;
    }
    if (isBinary) {
      if (bytes.length % 2 !== 0 || bytes.length === 0 || bytes.length > MAX_PCM_BYTES) {
        socket.close(1003, "invalid audio frame");
        return;
      }
      try {
        session.handleAudio(bytes);
      } catch (error) {
        // A vendor send failure must not crash the gateway process; the
        // turn fails through the normal recover path instead.
        this.log(this.tenantBySocket.get(socket) ?? "unknown", {
          msg: "gateway.audio_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch {
      this.logReject(socket, "invalid_json");
      this.sendError(socket, "bad_message", "Invalid JSON.");
      return;
    }
    let message;
    try {
      message = parseClientMessage(raw);
    } catch {
      this.logReject(socket, "schema_rejected");
      if (isWrongVersion(raw)) {
        this.sendError(socket, "unsupported_version", "Unsupported protocol version.");
      } else {
        this.sendError(socket, "bad_message", "Message failed validation.");
      }
      return;
    }
    if (message.type === "session.start") {
      const timer = this.setupTimers.get(socket);
      if (timer) clearTimeout(timer);
      this.setupTimers.delete(socket);
    }
    await session.handleMessage(message);
  }

  private sendError(socket: WebSocket, code: "bad_message" | "unsupported_version", message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "error", code, message, fatal: false }));
    } catch {
      /* socket already gone */
    }
  }

  private logReject(socket: WebSocket, reason: string): void {
    this.log(this.tenantBySocket.get(socket) ?? "unknown", { msg: "gateway.message_rejected", reason });
  }

  private log(tenantId: string, fields: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "INFO",
        service: "voice-gateway",
        tenant_id: tenantId,
        ...fields,
      }),
    );
  }
}

/** A session.start with a non-current protocol version (never a generic bad_message). */
function isWrongVersion(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const candidate = raw as { type?: unknown; protocolVersion?: unknown };
  return candidate.type === "session.start" && candidate.protocolVersion !== VOICE_PROTOCOL_VERSION;
}
