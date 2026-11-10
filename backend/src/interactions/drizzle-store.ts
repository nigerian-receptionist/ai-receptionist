import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";

import {
  ConflictError,
  InvalidStateError,
  InvalidTurnError,
  NotFoundError,
} from "../common/errors";
import { uuidv7 } from "../common/uuidv7";
import { DbService } from "../db/db.service";
import { agents, interactions, tenants, turns } from "../db/schema";
import { redact } from "../privacy/redact";
import {
  INTERACTION_STORE,
  turnRecordSchema,
  type EndReason,
  type InteractionStore,
  type RecordingState,
  type TurnRecord,
} from "./interaction-store";
import { toPublicId, toRawId } from "./ids";

export { INTERACTION_STORE };

const END_REASONS: readonly EndReason[] = ["caller_hangup", "agent_ended", "error", "timeout"];

/** Forward-only recording machine (M25). Same-state re-sets are idempotent no-ops. */
const RECORDING_TRANSITIONS: Record<RecordingState, readonly RecordingState[]> = {
  not_started: ["notice_playing"],
  notice_playing: ["notice_confirmed"],
  notice_confirmed: ["recording"],
  recording: [],
};

const RECORDABLE_STATES: readonly RecordingState[] = ["notice_confirmed", "recording"];

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  if (cause?.code === "23505") return true;
  const message = `${(error as { message?: string })?.message ?? ""} ${
    (cause as { message?: string })?.message ?? ""
  }`;
  return /duplicate key|unique constraint/i.test(message);
}

/**
 * Postgres InteractionStore. Every method runs inside `withTenant`, so RLS
 * scopes all reads and writes; a row from another tenant reads as missing.
 */
@Injectable()
export class DrizzleInteractionStore implements InteractionStore {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async startInteraction(input: {
    tenantId: string;
    agentId: string;
    channel: "web_voice";
    direction: "inbound";
    contactId?: string;
  }): Promise<{ interactionId: string }> {
    const agentRawId = toRawId(input.agentId, "agt");
    return this.db.withTenant(input.tenantId, async (tx) => {
      const agent = (
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentRawId)).limit(1)
      )[0];
      if (!agent) throw new NotFoundError("agent");
      const [row] = await tx
        .insert(interactions)
        .values({
          id: uuidv7(),
          tenantId: input.tenantId,
          agentId: agent.id,
          contactId: input.contactId ? toRawId(input.contactId, "con") : null,
          channel: input.channel,
          direction: input.direction,
          status: "open",
          recordingState: "not_started",
        })
        .returning({ id: interactions.id });
      if (!row) throw new Error("Interaction insert returned no row");
      return { interactionId: toPublicId("int", row.id) };
    });
  }

  async setRecordingState(
    tenantId: string,
    interactionId: string,
    state: RecordingState,
    noticeProof?: { blockId: string; blockVersion: number; blockHash: string; deliveredAt: Date },
  ): Promise<void> {
    const rawId = toRawId(interactionId, "int");
    await this.db.withTenant(tenantId, async (tx) => {
      const row = (
        await tx
          .select({
            id: interactions.id,
            recordingState: interactions.recordingState,
            noticeBlockId: interactions.noticeBlockId,
          })
          .from(interactions)
          .where(eq(interactions.id, rawId))
          .limit(1)
      )[0];
      if (!row) throw new NotFoundError("interaction");
      if (row.recordingState === state) {
        // Idempotent re-set; still fill proof when newly provided.
        if (noticeProof) {
          await tx
            .update(interactions)
            .set({
              noticeBlockId: noticeProof.blockId,
              noticeBlockVersion: noticeProof.blockVersion,
              noticeBlockHash: noticeProof.blockHash,
              noticeDeliveredAt: noticeProof.deliveredAt,
              updatedAt: new Date(),
            })
            .where(eq(interactions.id, rawId));
        }
        return;
      }
      const current = row.recordingState as RecordingState;
      if (!RECORDING_TRANSITIONS[current].includes(state)) {
        throw new InvalidStateError(`Illegal recording transition ${current} -> ${state}`);
      }
      if ((state === "notice_confirmed" || state === "recording") && !noticeProof && !row.noticeBlockId) {
        throw new InvalidStateError(`Entering ${state} requires notice proof`);
      }
      await tx
        .update(interactions)
        .set({
          recordingState: state,
          // Proof columns are written only when proof is provided, never
          // cleared by a later proof-less transition.
          ...(noticeProof
            ? {
                noticeBlockId: noticeProof.blockId,
                noticeBlockVersion: noticeProof.blockVersion,
                noticeBlockHash: noticeProof.blockHash,
                noticeDeliveredAt: noticeProof.deliveredAt,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(interactions.id, rawId));
    });
  }

  async appendTurn(tenantId: string, turn: TurnRecord): Promise<{ turnId: string }> {
    const parsed = turnRecordSchema.safeParse(turn);
    if (!parsed.success) {
      throw new InvalidTurnError(parsed.error.issues[0]?.message ?? "schema violation");
    }
    const rawId = toRawId(turn.interactionId, "int");
    return this.db.withTenant(tenantId, async (tx) => {
      const interaction = (
        await tx
          .select({ id: interactions.id, recordingState: interactions.recordingState })
          .from(interactions)
          .where(eq(interactions.id, rawId))
          .limit(1)
      )[0];
      if (!interaction) throw new NotFoundError("interaction");
      if (!RECORDABLE_STATES.includes(interaction.recordingState as RecordingState)) {
        throw new InvalidStateError(
          `Cannot append turns while recording is ${interaction.recordingState}`,
        );
      }
      try {
        const [row] = await tx
          .insert(turns)
          .values({
            id: uuidv7(),
            tenantId,
            interactionId: rawId,
            seq: turn.seq,
            speaker: turn.speaker,
            text: redact(turn.text),
            spokenText: turn.spokenText === undefined ? null : redact(turn.spokenText),
            language: turn.language,
            interrupted: turn.interrupted,
            sttModelId: turn.sttModelId,
            sttConfidence: turn.sttConfidence ?? null,
            llmModel: turn.llmModel,
            promptVersion: turn.promptVersion ?? null,
            ttsModelId: turn.ttsModelId,
            voiceId: turn.voiceId,
            blockId: turn.blockId,
            blockVersion: turn.blockVersion,
            blockHash: turn.blockHash,
            timingsMs: turn.timingsMs,
            tokens: turn.tokens ?? null,
          })
          .returning({ id: turns.id });
        if (!row) throw new Error("Turn insert returned no row");
        return { turnId: toPublicId("trn", row.id) };
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof InvalidStateError) throw error;
        if (isUniqueViolation(error)) {
          throw new ConflictError(`Duplicate turn seq ${turn.seq}`);
        }
        throw error;
      }
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
      if (updated.length === 0) throw new NotFoundError("interaction");
    });
  }

  async getAgentForSession(
    tenantId: string,
    agentId?: string,
  ): Promise<{
    agentId: string;
    orgName: string;
    personaPrompt: string;
    voiceId: string | null;
    language: string;
  }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const row = (
        agentId === undefined
          ? // Default pick: oldest active agent (stable, skips retired drafts).
            await tx
              .select()
              .from(agents)
              .where(and(eq(agents.tenantId, tenantId), eq(agents.status, "active")))
              .orderBy(asc(agents.createdAt), asc(agents.id))
              .limit(1)
          : await tx.select().from(agents).where(eq(agents.id, toRawId(agentId, "agt"))).limit(1)
      )[0];
      if (!row) throw new NotFoundError("agent");
      const tenant = (
        await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
      )[0];
      if (!tenant) throw new NotFoundError("tenant");
      return {
        agentId: toPublicId("agt", row.id),
        orgName: tenant.name,
        personaPrompt: row.personaPrompt,
        voiceId: row.voiceId,
        language: row.language,
      };
    });
  }
}
