import { z } from "zod";

import type { ClientMessage } from "./protocol";
import { VOICE_PROTOCOL_VERSION } from "./protocol";

export type { ClientMessage };

/** Runtime validation for every client JSON message (see protocol.ts). */
export const ClientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    protocolVersion: z.literal(VOICE_PROTOCOL_VERSION),
    agentId: z.string().min(1).max(128).optional(),
    inputSampleRate: z.literal(16000),
  }),
  z.object({ type: z.literal("input.speech_started"), atMs: z.number().finite() }),
  z.object({ type: z.literal("input.speech_ended"), atMs: z.number().finite() }),
  z.object({ type: z.literal("playback.done"), utteranceId: z.string().min(1).max(128) }),
  z.object({
    type: z.literal("playback.interrupted"),
    utteranceId: z.string().min(1).max(128),
    playedMs: z.number().finite().min(0),
  }),
  z.object({
    type: z.literal("playback.progress"),
    utteranceId: z.string().min(1).max(128),
    playedMs: z.number().finite().min(0),
  }),
  z.object({ type: z.literal("session.end") }),
]);

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessageSchema.parse(raw);
}
