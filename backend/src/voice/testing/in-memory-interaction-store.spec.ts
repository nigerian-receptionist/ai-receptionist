import { describe, expect, it } from "vitest";

import {
  ConflictError,
  InvalidStateError,
  InvalidTurnError,
  NotFoundError,
} from "../../common/errors";
import { InMemoryInteractionStore } from "./in-memory-interaction-store";

const TENANT = "0195f3a0-0000-7000-8000-000000000001";
const PROOF = { blockId: "recording_notice", blockVersion: 1, blockHash: "abc", deliveredAt: new Date() };

async function started(store = new InMemoryInteractionStore()) {
  const { interactionId } = await store.startInteraction({
    tenantId: TENANT,
    agentId: "agt_test",
    channel: "web_voice",
    direction: "inbound",
  });
  return { store, interactionId };
}

describe("InMemoryInteractionStore contract parity", () => {
  it("walks the forward-only recording machine with proof", async () => {
    const { store, interactionId } = await started();
    await store.setRecordingState(TENANT, interactionId, "notice_playing");
    await expect(store.setRecordingState(TENANT, interactionId, "recording")).rejects.toThrow(
      InvalidStateError,
    );
    await expect(
      store.setRecordingState(TENANT, interactionId, "notice_confirmed"),
    ).rejects.toThrow(/proof/);
    await store.setRecordingState(TENANT, interactionId, "notice_confirmed", PROOF);
    await store.setRecordingState(TENANT, interactionId, "recording");
    expect(store.interactions.get(interactionId)?.recordingState).toBe("recording");
  });

  it("rejects appends before the notice handshake and validates turns", async () => {
    const { store, interactionId } = await started();
    await store.setRecordingState(TENANT, interactionId, "notice_playing");
    await expect(
      store.appendTurn(TENANT, {
        interactionId,
        seq: 1,
        speaker: "caller",
        text: "hi",
        language: "en",
        interrupted: false,
        timingsMs: {},
      }),
    ).rejects.toThrow(InvalidStateError);
    await expect(
      store.appendTurn(TENANT, {
        interactionId,
        seq: 0,
        speaker: "caller",
        text: "",
        language: "en",
        interrupted: false,
        timingsMs: {},
      }),
    ).rejects.toThrow(InvalidTurnError);
  });

  it("rejects duplicate seqs and redacts stored text", async () => {
    const { store, interactionId } = await started();
    await store.setRecordingState(TENANT, interactionId, "notice_playing");
    await store.setRecordingState(TENANT, interactionId, "notice_confirmed", PROOF);
    await store.setRecordingState(TENANT, interactionId, "recording");
    await store.appendTurn(TENANT, {
      interactionId,
      seq: 1,
      speaker: "caller",
      text: "my card is 4111111111111111",
      language: "en",
      interrupted: false,
      timingsMs: {},
    });
    await expect(
      store.appendTurn(TENANT, {
        interactionId,
        seq: 1,
        speaker: "caller",
        text: "again",
        language: "en",
        interrupted: false,
        timingsMs: {},
      }),
    ).rejects.toThrow(ConflictError);
    const turns = store.interactions.get(interactionId)?.turns ?? [];
    expect(turns[0]?.text).toBe("my card is [CARD]");
  });

  it("throws NotFoundError for unknown interactions", async () => {
    const { store } = await started();
    await expect(
      store.appendTurn(TENANT, {
        interactionId: "int_00000000-0000-4000-8000-000000000000",
        seq: 1,
        speaker: "caller",
        text: "hi",
        language: "en",
        interrupted: false,
        timingsMs: {},
      }),
    ).rejects.toThrow(NotFoundError);
  });
});
