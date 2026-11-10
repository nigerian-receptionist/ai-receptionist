import { randomUUID } from "node:crypto";

import { ConflictError, InvalidStateError, InvalidTurnError, NotFoundError } from "../../common/errors";
import {
  INTERACTION_STORE,
  turnRecordSchema,
  type EndReason,
  type InteractionStore,
  type RecordingState,
  type TurnRecord,
} from "../../interactions/interaction-store";
import { toPublicId } from "../../interactions/ids";
import { redact } from "../../privacy/redact";

export { INTERACTION_STORE };

export interface StoredInteraction {
  interactionId: string;
  recordingState: RecordingState;
  noticeProof?: { blockId: string; blockVersion: number; blockHash: string; deliveredAt: Date };
  turns: (TurnRecord & { turnId: string })[];
  endReason: EndReason | null;
  complianceFlags: string[];
}

/** Forward-only recording machine (M25), mirroring the Postgres store. */
const RECORDING_TRANSITIONS: Record<RecordingState, readonly RecordingState[]> = {
  not_started: ["notice_playing"],
  notice_playing: ["notice_confirmed"],
  notice_confirmed: ["recording"],
  recording: [],
};

const RECORDABLE_STATES: readonly RecordingState[] = ["notice_confirmed", "recording"];

/**
 * In-memory InteractionStore for voice-loop unit tests and local demos.
 * Enforces the same contract as DrizzleInteractionStore (redaction, forward-
 * only recording transitions, proof requirement, append gating, validation,
 * seq uniqueness) minus persistence and RLS.
 */
export class InMemoryInteractionStore implements InteractionStore {
  readonly interactions = new Map<string, StoredInteraction>();

  async startInteraction(_input: {
    tenantId: string;
    agentId: string;
    channel: "web_voice";
    direction: "inbound";
  }): Promise<{ interactionId: string }> {
    const interactionId = toPublicId("int", randomUUID());
    this.interactions.set(interactionId, {
      interactionId,
      recordingState: "not_started",
      turns: [],
      endReason: null,
      complianceFlags: [],
    });
    return { interactionId };
  }

  async setRecordingState(
    tenantId: string,
    interactionId: string,
    state: RecordingState,
    noticeProof?: { blockId: string; blockVersion: number; blockHash: string; deliveredAt: Date },
  ): Promise<void> {
    const interaction = this.get(tenantId, interactionId);
    if (interaction.recordingState === state) {
      if (noticeProof) interaction.noticeProof = noticeProof;
      return;
    }
    if (!RECORDING_TRANSITIONS[interaction.recordingState].includes(state)) {
      throw new InvalidStateError(
        `Illegal recording transition ${interaction.recordingState} -> ${state}`,
      );
    }
    if ((state === "notice_confirmed" || state === "recording") && !noticeProof && !interaction.noticeProof) {
      throw new InvalidStateError(`Entering ${state} requires notice proof`);
    }
    interaction.recordingState = state;
    if (noticeProof) interaction.noticeProof = noticeProof;
  }

  async appendTurn(tenantId: string, turn: TurnRecord): Promise<{ turnId: string }> {
    const parsed = turnRecordSchema.safeParse(turn);
    if (!parsed.success) {
      throw new InvalidTurnError(parsed.error.issues[0]?.message ?? "schema violation");
    }
    const interaction = this.get(tenantId, turn.interactionId);
    if (!RECORDABLE_STATES.includes(interaction.recordingState)) {
      throw new InvalidStateError(
        `Cannot append turns while recording is ${interaction.recordingState}`,
      );
    }
    if (interaction.turns.some((existing) => existing.seq === turn.seq)) {
      throw new ConflictError(`Duplicate turn seq ${turn.seq}`);
    }
    const turnId = `trn_${randomUUID().replace(/-/g, "")}`;
    // M16: the MUST-redact contract (AGENTS.md 9.2) applies to tests and
    // demos too, mirroring DrizzleInteractionStore.
    interaction.turns.push({
      ...turn,
      turnId,
      text: redact(turn.text),
      spokenText: turn.spokenText === undefined ? undefined : redact(turn.spokenText),
    });
    return { turnId };
  }

  async endInteraction(
    tenantId: string,
    interactionId: string,
    endReason: EndReason,
    opts: { complianceFlags?: string[] } = {},
  ): Promise<void> {
    const interaction = this.get(tenantId, interactionId);
    interaction.endReason = endReason;
    if (opts.complianceFlags !== undefined) interaction.complianceFlags = opts.complianceFlags;
  }

  async getAgentForSession(
    _tenantId: string,
    _agentId?: string,
  ): Promise<{
    agentId: string;
    orgName: string;
    personaPrompt: string;
    voiceId: string | null;
    language: string;
  }> {
    return {
      agentId: "agt_test",
      orgName: "Test Org",
      personaPrompt: "Be brief and friendly.",
      voiceId: "fake-voice",
      language: "en",
    };
  }

  private get(_tenantId: string, interactionId: string): StoredInteraction {
    const interaction = this.interactions.get(interactionId);
    if (!interaction) throw new NotFoundError("interaction");
    return interaction;
  }
}
