import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { Principal } from "../auth/dev-auth";
import type { Env } from "../config/env";
import { InMemoryInteractionStore } from "./testing/in-memory-interaction-store";
import { VoiceGateway } from "./voice.gateway";
import type { VoiceSession } from "./voice-session";

const TENANT = "0195f3a0-0000-7000-8000-000000000001";
const TOKEN = "test-token-0123456789abcdef";
const ORIGIN = "http://127.0.0.1:3000";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  terminated = false;
  autoPong = true;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSED;
    this.closed.push({ code: code ?? 0, reason: reason ?? "" });
  }

  ping(): void {
    if (this.autoPong) this.emit("pong");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }

  errors(): Array<{ code: string; message: string }> {
    return this.sent
      .map((raw) => JSON.parse(raw) as { type?: string; code?: string; message?: string })
      .filter((m) => m.type === "error")
      .map((m) => ({ code: m.code ?? "", message: m.message ?? "" }));
  }
}

class StubSession {
  currentInteractionId: string | null = null;
  readonly messages: unknown[] = [];
  readonly audio: Buffer[] = [];
  failAudio = false;
  transportClosed = false;

  async handleMessage(message: unknown): Promise<void> {
    this.messages.push(message);
    if ((message as { type?: string }).type === "session.start") {
      this.currentInteractionId = "int_stub";
    }
  }

  handleAudio(pcm: Buffer): void {
    if (this.failAudio) throw new Error("vendor send blew up");
    this.audio.push(pcm);
  }

  async handleTransportClose(): Promise<void> {
    this.transportClosed = true;
  }
}

class TestGateway extends VoiceGateway {
  readonly created: StubSession[] = [];
  failNextAudio = false;

  protected override createSession(_principal: Principal, _socket: WebSocket): VoiceSession {
    const stub = new StubSession();
    stub.failAudio = this.failNextAudio;
    this.created.push(stub);
    return stub as unknown as VoiceSession;
  }
}

function testEnv(): Env {
  return {
    APP_ENV: "local",
    ALLOWED_ORIGINS: [ORIGIN],
    DEV_ACCESS_TOKEN: TOKEN,
    DEV_TENANT_ID: TENANT,
  } as Env;
}

function request(origin: string, token: string | null): IncomingMessage {
  const url = token === null ? "/v1/voice" : `/v1/voice?token=${token}`;
  return { headers: { origin }, url } as IncomingMessage;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VoiceGateway", () => {
  let gateway: TestGateway;

  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    gateway = new TestGateway(testEnv(), new InMemoryInteractionStore());
    gateway.onModuleInit();
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function connect(socket: FakeSocket, token: string | null = TOKEN, origin = ORIGIN): void {
    gateway.handleConnection(socket as unknown as WebSocket, request(origin, token));
  }

  it("rejects a disallowed origin and a bad token", () => {
    const badOrigin = new FakeSocket();
    connect(badOrigin, TOKEN, "https://evil.example");
    expect(badOrigin.closed).toEqual([{ code: 4403, reason: "origin not allowed" }]);

    const badToken = new FakeSocket();
    connect(badToken, "wrong-token");
    expect(badToken.closed).toEqual([{ code: 4401, reason: "invalid token" }]);

    const ok = new FakeSocket();
    connect(ok);
    expect(ok.closed).toHaveLength(0);
    expect(gateway.created).toHaveLength(1);
  });

  it("limits concurrent sessions per tenant", () => {
    const sockets = Array.from({ length: 6 }, () => new FakeSocket());
    for (const socket of sockets) connect(socket);
    expect(sockets.filter((s) => s.closed.length > 0)).toHaveLength(1);
    expect(sockets[5]?.closed).toEqual([{ code: 4403, reason: "too many sessions" }]);
  });

  it("closes oversized and malformed binary frames", async () => {
    const socket = new FakeSocket();
    connect(socket);
    socket.emit("message", Buffer.alloc(65 * 1024), true);
    await tick();
    expect(socket.closed).toEqual([{ code: 1003, reason: "invalid audio frame" }]);

    const big = new FakeSocket();
    // Swap tokens is unnecessary: same tenant, but slots allow it.
    gateway.handleConnection(big as unknown as WebSocket, request(ORIGIN, TOKEN));
    big.emit("message", Buffer.alloc(257 * 1024), true);
    await tick();
    expect(big.closed).toEqual([{ code: 1009, reason: "message too large" }]);
  });

  it("survives garbage binary frames without rejecting (try/catch)", async () => {
    const socket = new FakeSocket();
    connect(socket);
    // Non-convertible RawData must close 1003, never throw.
    await expect(
      (gateway as unknown as {
        handleSocketMessage: (
          socket: unknown,
          session: unknown,
          data: unknown,
          isBinary: boolean,
        ) => Promise<void>;
      }).handleSocketMessage(socket, gateway.created[0], 12345, true),
    ).resolves.toBeUndefined();
    expect(socket.closed).toEqual([{ code: 1003, reason: "invalid frame" }]);
  });

  it("logs a vendor audio failure and keeps the connection open", async () => {
    gateway.failNextAudio = true;
    const socket = new FakeSocket();
    connect(socket);
    await (gateway as unknown as {
      handleSocketMessage: (
        socket: unknown,
        session: unknown,
        data: unknown,
        isBinary: boolean,
      ) => Promise<void>;
    }).handleSocketMessage(socket, gateway.created[0], Buffer.alloc(640), true);
    expect(socket.closed).toHaveLength(0);
    expect(console.log).toHaveBeenCalled();
  });

  it("maps a wrong protocol version to unsupported_version and logs rejections", async () => {
    const socket = new FakeSocket();
    connect(socket);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session.start", protocolVersion: 999, inputSampleRate: 16000 })),
      false,
    );
    await tick();
    expect(socket.errors()).toEqual([{ code: "unsupported_version", message: "Unsupported protocol version." }]);
    expect(socket.closed).toHaveLength(0);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "nope" })), false);
    await tick();
    expect(socket.errors()).toHaveLength(2);
    expect(socket.errors()[1]?.code).toBe("bad_message");
    const logged = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("gateway.message_rejected"))).toBe(true);
  });

  it("closes setup zombies and frees the tenant slot", async () => {
    vi.useFakeTimers();
    const sockets = Array.from({ length: 5 }, () => new FakeSocket());
    for (const socket of sockets) connect(socket);
    const extra = new FakeSocket();
    connect(extra);
    expect(extra.closed).toEqual([{ code: 4403, reason: "too many sessions" }]);

    await vi.advanceTimersByTimeAsync(31_000);
    for (const socket of sockets) {
      expect(socket.closed).toEqual([{ code: 4408, reason: "session.start not received" }]);
    }
    const retry = new FakeSocket();
    connect(retry);
    expect(retry.closed).toHaveLength(0);
  });

  it("keeps sockets that sent session.start past the setup timeout", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    connect(socket);
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "session.start", protocolVersion: 1, inputSampleRate: 16000 })),
      false,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.created[0]?.messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.closed).toHaveLength(0);
  });

  it("terminates heartbeat-dead sockets and keeps live ones", async () => {
    vi.useFakeTimers();
    // Re-arm the heartbeat interval under fake timers.
    gateway.onModuleDestroy();
    gateway.onModuleInit();
    const live = new FakeSocket();
    const dead = new FakeSocket();
    dead.autoPong = false;
    connect(live);
    connect(dead);
    for (const socket of [live, dead]) {
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "session.start", protocolVersion: 1, inputSampleRate: 16000 })),
        false,
      );
    }
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(dead.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dead.terminated).toBe(true);
    expect(live.terminated).toBe(false);
    expect(live.closed).toHaveLength(0);
  });
});
