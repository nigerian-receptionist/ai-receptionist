import { randomUUID } from "node:crypto";

import {
  INTERACTION_STORE,
  type EndReason,
  type InteractionStore,
  type RecordingState,
  type TurnRecord,
} from "../../interactions/interaction-store";

export { INTERACTION_STORE };

export interface StoredInteraction {
  interactionId: string;
  tenantId: string;
  agentId: string;
  channel: string;
  direction: string;
  recordingState: RecordingState;
  noticeProof?: { blockId: string; blockVersion: number; blockHash: string; deliveredAt: Date };
  turns: (TurnRecord & { turnId: string })[];
  endReason: EndReason | null;
}

/**
 * Non-persistent InteractionStore for voice-gateway tests and local runs.
 * The data-layer agent replaces this binding with the Postgres implementation.
 */
export class InMemoryInteractionStore implements InteractionStore {
  readonly interactions = new Map<string, StoredInteraction>();

  async startInteraction(input: {
    tenantId: string;
    agentId: string;
    channel: "web_voice";
    direction: "inbound";
  }): Promise<{ interactionId: string }> {
    const interactionId = `int_${randomUUID().replace(/-/g, "")}`;
    this.interactions.set(interactionId, {
      interactionId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      channel: input.channel,
      direction: input.direction,
      recordingState: "not_started",
      turns: [],
      endReason: null,
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
    interaction.recordingState = state;
    if (noticeProof) interaction.noticeProof = noticeProof;
  }

  async appendTurn(tenantId: string, turn: TurnRecord): Promise<{ turnId: string }> {
    const interaction = this.get(tenantId, turn.interactionId);
    const turnId = `trn_${randomUUID().replace(/-/g, "")}`;
    interaction.turns.push({ ...turn, turnId });
    return { turnId };
  }

  async endInteraction(tenantId: string, interactionId: string, endReason: EndReason): Promise<void> {
    this.get(tenantId, interactionId).endReason = endReason;
  }

  async getAgentForSession(
    _tenantId: string,
    agentId: string | undefined,
  ): Promise<{
    agentId: string;
    orgName: string;
    personaPrompt: string;
    voiceId: string | null;
    language: string;
  }> {
    return {
      agentId: agentId ?? "agent_default",
      orgName: "Demo Organisation",
      personaPrompt: "You are a friendly receptionist. Keep replies short and helpful.",
      voiceId: null,
      language: "en-NG",
    };
  }

  private get(tenantId: string, interactionId: string): StoredInteraction {
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.tenantId !== tenantId) throw new Error("interaction not found");
    return interaction;
  }
}
