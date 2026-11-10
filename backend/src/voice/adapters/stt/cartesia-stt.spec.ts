import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CartesiaSttSession } from "./cartesia-stt";

class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  failSend = false;

  override send(data: unknown): void {
    if (this.failSend) throw new Error("socket send failed");
    this.sent.push(data);
  }

  override close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  serverMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function makeSession(ws: FakeWs, finalizeTimeoutMs = 5000): CartesiaSttSession {
  return new CartesiaSttSession(ws as unknown as WebSocket, {
    modelId: "stt_cartesia@test",
    language: "en",
    sampleRate: 16000,
    finalizeTimeoutMs,
  });
}

describe("CartesiaSttSession", () => {
  it("resolves finalize with concatenated finals and audio seconds", async () => {
    const ws = new FakeWs();
    const session = makeSession(ws);
    session.sendAudio(Buffer.alloc(3200)); // 100 ms at 16 kHz
    const pending = session.finalize();
    ws.serverMessage({ type: "transcript", is_final: true, text: "hello " });
    ws.serverMessage({ type: "transcript", is_final: true, text: "there" });
    ws.serverMessage({ type: "flush_done" });
    const result = await pending;
    expect(result.text).toBe("hello there");
    expect(result.audioS).toBeCloseTo(0.1, 5);
    ws.close();
    await session.close();
  });

  it("M2: a timed-out finalize does not poison later turns", async () => {
    const ws = new FakeWs();
    const session = makeSession(ws, 20);
    ws.serverMessage({ type: "transcript", is_final: true, text: "stale " });
    await expect(session.finalize()).rejects.toThrow("stt finalize timed out");
    // Late vendor output for the abandoned turn is dropped...
    ws.serverMessage({ type: "transcript", is_final: true, text: "stale " });
    ws.serverMessage({ type: "flush_done" });
    // ...so the next turn is clean.
    const pending = session.finalize();
    ws.serverMessage({ type: "transcript", is_final: true, text: "fresh" });
    ws.serverMessage({ type: "flush_done" });
    await expect(pending).resolves.toMatchObject({ text: "fresh" });
    ws.close();
    await session.close();
  });

  it("M2: a waiter-less flush_done clears stale buffers", async () => {
    const ws = new FakeWs();
    const session = makeSession(ws);
    ws.serverMessage({ type: "transcript", is_final: true, text: "orphan " });
    ws.serverMessage({ type: "flush_done" });
    const pending = session.finalize();
    ws.serverMessage({ type: "transcript", is_final: true, text: "next" });
    ws.serverMessage({ type: "flush_done" });
    await expect(pending).resolves.toMatchObject({ text: "next" });
    ws.close();
    await session.close();
  });

  it("reset() abandons the in-flight finalize and clears buffers", async () => {
    const ws = new FakeWs();
    const session = makeSession(ws);
    ws.serverMessage({ type: "transcript", is_final: true, text: "abandoned " });
    const pending = session.finalize();
    const settled = pending.then(
      () => "resolved",
      (error: Error) => error.name,
    );
    session.reset();
    await expect(settled).resolves.toBe("AbortError");
    const next = session.finalize();
    ws.serverMessage({ type: "transcript", is_final: true, text: "clean" });
    ws.serverMessage({ type: "flush_done" });
    await expect(next).resolves.toMatchObject({ text: "clean" });
    ws.close();
    await session.close();
  });

  it("rejects finalize while the socket is not open, without dangling", async () => {
    const ws = new FakeWs();
    ws.readyState = WebSocket.CONNECTING;
    const session = makeSession(ws);
    await expect(session.finalize()).rejects.toThrow("not open");
    ws.readyState = WebSocket.OPEN;
    const pending = session.finalize();
    ws.serverMessage({ type: "transcript", is_final: true, text: "ok" });
    ws.serverMessage({ type: "flush_done" });
    await expect(pending).resolves.toMatchObject({ text: "ok" });
    ws.close();
    await session.close();
  });

  it("a send failure clears the waiter so the next finalize works", async () => {
    const ws = new FakeWs();
    const session = makeSession(ws);
    ws.failSend = true;
    await expect(session.finalize()).rejects.toThrow("socket send failed");
    ws.failSend = false;
    const pending = session.finalize();
    ws.serverMessage({ type: "transcript", is_final: true, text: "recovered" });
    ws.serverMessage({ type: "flush_done" });
    await expect(pending).resolves.toMatchObject({ text: "recovered" });
    ws.close();
    await session.close();
  });

  it("buffers audio while connecting and flushes on open", async () => {
    const ws = new FakeWs();
    ws.readyState = WebSocket.CONNECTING;
    const session = makeSession(ws);
    session.sendAudio(Buffer.alloc(640));
    session.sendAudio(Buffer.alloc(640));
    expect(ws.sent).toHaveLength(0);
    ws.readyState = WebSocket.OPEN;
    ws.emit("open");
    expect(ws.sent).toHaveLength(2);
    expect(session.droppedAudioFrames).toBe(0);
    ws.close();
    await session.close();
  });

  it("drops audio above the vendor bufferedAmount cap and counts it", async () => {
    const ws = new FakeWs();
    ws.bufferedAmount = 1024 * 1024;
    const session = makeSession(ws);
    session.sendAudio(Buffer.alloc(640));
    expect(ws.sent).toHaveLength(0);
    expect(session.droppedAudioFrames).toBe(1);
    ws.close();
    await session.close();
  });
});
