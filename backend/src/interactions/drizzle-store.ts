import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { uuidv7 } from "../common/uuidv7";
import { DbService } from "../db/db.service";
import { agents, interactions, tenants, turns } from "../db/schema";
import { redact } from "../privacy/redact";
import { toPublicId, toRawId } from "./ids";
import type {
  EndReason,
  InteractionStore,
  RecordingState,
  TurnRecord,
} from "./interaction-store";

const RECORDING_STATES: readonly RecordingState[] = [
  "not_started",
  "notice_playing",
  "notice_confirmed",
  "recording",
];

const END_REASONS: readonly EndReason[] = ["caller_hangup", "agent_ended", "error", "timeout"];

/**
 * Postgres-backed InteractionStore. Every call runs inside `withTenant` (RLS),
 * and turn text is redacted before insert. Never logs turn text.
 */
@Injectable()
export class DrizzleInteractionStore implements InteractionStore {
  constructor(private readonly db: DbService) {}

  async startInteraction(input: {
    tenantId: string;
    agentId: string;
    channel: "web_voice";
    direction: "inbound";
  }): Promise<{ interactionId: string }> {
    const agentRawId = toRawId(input.agentId, "agt");
    return this.db.withTenant(input.tenantId, async (tx) => {
      const found = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentRawId))
        .limit(1);
      if (found.length === 0) throw new Error("Agent not found");
      const id = uuidv7();
      await tx.insert(interactions).values({
        id,
        tenantId: input.tenantId,
        agentId: agentRawId,
        channel: input.channel,
        direction: input.direction,
        status: "open",
        recordingState: "not_started",
      });
      return { interactionId: toPublicId("int", id) };
    });
  }

  async setRecordingState(
    tenantId: string,
    interactionId: string,
    state: RecordingState,
    noticeProof?: { blockId: string; blockVersion: number; blockHash: string; deliveredAt: Date },
  ): Promise<void> {
    if (!RECORDING_STATES.includes(state)) throw new Error("Invalid recording state");
    const rawId = toRawId(interactionId, "int");
    await this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx
        .update(interactions)
        .set({
          recordingState: state,
          noticeBlockId: noticeProof?.blockId,
          noticeBlockVersion: noticeProof?.blockVersion,
          noticeBlockHash: noticeProof?.blockHash,
          noticeDeliveredAt: noticeProof?.deliveredAt,
          updatedAt: new Date(),
        })
        .where(eq(interactions.id, rawId))
        .returning({ id: interactions.id });
      if (updated.length === 0) throw new Error("Interaction not found");
    });
  }

  async appendTurn(tenantId: string, turn: TurnRecord): Promise<{ turnId: string }> {
    const interactionRawId = toRawId(turn.interactionId, "int");
    return this.db.withTenant(tenantId, async (tx) => {
      const found = await tx
        .select({ id: interactions.id })
        .from(interactions)
        .where(eq(interactions.id, interactionRawId))
        .limit(1);
      if (found.length === 0) throw new Error("Interaction not found");
      const id = uuidv7();
      await tx.insert(turns).values({
        id,
        tenantId,
        interactionId: interactionRawId,
        seq: turn.seq,
        speaker: turn.speaker,
        text: redact(turn.text),
        spokenText: turn.spokenText === undefined ? undefined : redact(turn.spokenText),
        language: turn.language,
        interrupted: turn.interrupted,
        sttModelId: turn.sttModelId,
        sttConfidence: turn.sttConfidence ?? null,
        llmModel: turn.llmModel,
        ttsModelId: turn.ttsModelId,
        voiceId: turn.voiceId,
        blockId: turn.blockId,
        blockVersion: turn.blockVersion,
        blockHash: turn.blockHash,
        timingsMs: turn.timingsMs,
        tokens: turn.tokens ?? null,
      });
      return { turnId: toPublicId("trn", id) };
    });
  }

  async endInteraction(
    tenantId: string,
    interactionId: string,
    endReason: EndReason,
    opts: { complianceFlags?: string[] } = {},
  ): Promise<void> {
    if (!END_REASONS.includes(endReason)) throw new Error("Invalid end reason");
    const rawId = toRawId(interactionId, "int");
    await this.db.withTenant(tenantId, async (tx) => {
      const updated = await tx
        .update(interactions)
        .set({
          status: "closed",
          endReason,
          ...(opts.complianceFlags === undefined ? {} : { complianceFlags: opts.complianceFlags }),
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(interactions.id, rawId))
        .returning({ id: interactions.id });
      if (updated.length === 0) throw new Error("Interaction not found");
    });
  }

  async getAgentForSession(
    tenantId: string,
    agentId: string | undefined,
  ): Promise<{
    agentId: string;
    orgName: string;
    personaPrompt: string;
    voiceId: string | null;
    language: string;
  }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows =
        agentId === undefined
          ? await tx.select().from(agents).orderBy(agents.createdAt).limit(1)
          : await tx.select().from(agents).where(eq(agents.id, toRawId(agentId, "agt"))).limit(1);
      const agent = rows[0];
      if (agent === undefined) throw new Error("Agent not found");
      const tenantRows = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const tenant = tenantRows[0];
      if (tenant === undefined) throw new Error("Tenant not found");
      return {
        agentId: toPublicId("agt", agent.id),
        orgName: tenant.name,
        personaPrompt: agent.personaPrompt,
        voiceId: agent.voiceId,
        language: agent.language,
      };
    });
  }
}
