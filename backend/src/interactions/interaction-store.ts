/**
 * Contract between the voice gateway (writer) and the data layer (implementation).
 *
 * The data-layer implementation MUST:
 *   - run every call inside a transaction with `SET LOCAL app.tenant_id = <tenantId>` (RLS),
 *   - redact sensitive values (card numbers, BVN/NIN, NUBAN, OTP/PIN, phone
 *     numbers, emails, URLs) from `text` and `spokenText` before writing
 *     (AGENTS.md 9.2 rule 10),
 *   - never log raw turn text.
 */

import { z } from "zod";

export type RecordingState = "not_started" | "notice_playing" | "notice_confirmed" | "recording";

export type EndReason = "caller_hangup" | "agent_ended" | "error" | "timeout";

/** Contract validation for turn writes (both stores enforce it). */
export const turnRecordSchema = z.object({
  interactionId: z.string().min(1),
  seq: z.number().int().positive(),
  speaker: z.enum(["caller", "agent"]),
  text: z.string().min(1),
  language: z.string().min(1),
});

export interface TurnRecord {
  interactionId: string;
  seq: number;
  speaker: "caller" | "agent";
  text: string;
  /** Agent turns: what the caller actually heard (truncated on barge-in). */
  spokenText?: string;
  language: string;
  interrupted: boolean;
  sttModelId?: string;
  sttConfidence?: number | null;
  llmModel?: string;
  /** Voice system prompt version (AGENTS.md 13.2 audit trail). */
  promptVersion?: number;
  ttsModelId?: string;
  voiceId?: string;
  /** Pre-rendered block played for this turn, if any (proof of notice delivery). */
  blockId?: string;
  blockVersion?: number;
  blockHash?: string;
  timingsMs: Record<string, number | null>;
  tokens?: { in: number | null; out: number | null; reasoning: number | null };
}

export interface InteractionStore {
  /** Creates the interaction row; returns its id (`int_` prefixed public id). */
  startInteraction(input: {
    tenantId: string;
    agentId: string;
    channel: "web_voice";
    direction: "inbound";
  }): Promise<{ interactionId: string }>;

  setRecordingState(
    tenantId: string,
    interactionId: string,
    state: RecordingState,
    noticeProof?: { blockId: string; blockVersion: number; blockHash: string; deliveredAt: Date },
  ): Promise<void>;

  appendTurn(tenantId: string, turn: TurnRecord): Promise<{ turnId: string }>;

  /**
   * Closes the interaction. `complianceFlags` marks compliance-relevant
   * outcomes for audit (e.g. `notice_failed` when the disclosure/notice was
   * never confirmed — AGENTS.md 9.1 rule 2); omit for ordinary closes.
   */
  endInteraction(
    tenantId: string,
    interactionId: string,
    endReason: EndReason,
    opts?: { complianceFlags?: string[] },
  ): Promise<void>;

  /** Loads the agent config the gateway needs (persona prompt, voice, language, org name). */
  getAgentForSession(
    tenantId: string,
    agentId?: string,
  ): Promise<{
    agentId: string;
    agentName: string;
    orgName: string;
    personaPrompt: string;
    voiceId: string | null;
    language: string;
  }>;
}

/** Nest injection token for InteractionStore. */
export const INTERACTION_STORE = Symbol("INTERACTION_STORE");
