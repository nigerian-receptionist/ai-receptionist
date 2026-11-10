import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toRawId } from "../../src/interactions/ids";
import type { DrizzleInteractionStore } from "../../src/interactions/drizzle-store";
import type { DbService } from "../../src/db/db.service";
import { interactions, turns } from "../../src/db/schema";
import type { Pool } from "pg";
import { createTenantWithAgent, createTestDb, deleteTenantData } from "../helpers/db";

describe("DrizzleInteractionStore round-trip (real Postgres, app role)", () => {
  let pool: Pool;
  let service: DbService;
  let store: DrizzleInteractionStore;
  let tenantId: string;
  let agentId: string;

  beforeAll(async () => {
    ({ pool, service, store } = createTestDb());
    ({ tenantId, agentId } = await createTenantWithAgent(service, "Store Test Ltd"));
  });

  afterAll(async () => {
    await deleteTenantData(service, tenantId).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("loads the agent with the org name, by default and by id", async () => {
    const byDefault = await store.getAgentForSession(tenantId, undefined);
    expect(byDefault.orgName).toBe("Store Test Ltd");
    expect(byDefault.agentId).toBe(`agt_${agentId}`);

    // Accepts both public and raw id forms.
    await expect(store.getAgentForSession(tenantId, `agt_${agentId}`)).resolves.toMatchObject({
      orgName: "Store Test Ltd",
    });
    await expect(store.getAgentForSession(tenantId, agentId)).resolves.toMatchObject({
      orgName: "Store Test Ltd",
    });
  });

  it("runs a full interaction lifecycle and redacts turns on disk", async () => {
    const { interactionId } = await store.startInteraction({
      tenantId,
      agentId, // raw form accepted
      channel: "web_voice",
      direction: "inbound",
    });
    expect(interactionId).toMatch(/^int_/);

    await store.setRecordingState(tenantId, interactionId, "notice_playing");
    await store.setRecordingState(tenantId, interactionId, "recording", {
      blockId: "recording_notice",
      blockVersion: 1,
      blockHash: "abc123",
      deliveredAt: new Date("2026-11-10T00:00:00.000Z"),
    });

    const caller = await store.appendTurn(tenantId, {
      interactionId, // public form accepted
      seq: 1,
      speaker: "caller",
      text: "my card is 4111111111111111 and call 08031234567",
      language: "en-NG",
      interrupted: false,
      sttModelId: "cartesia-ink",
      sttConfidence: 0.9,
      timingsMs: { stt: 120 },
      tokens: { in: null, out: null, reasoning: null },
    });
    expect(caller.turnId).toMatch(/^trn_/);

    await store.appendTurn(tenantId, {
      interactionId: toRawId(interactionId, "int"), // raw form accepted
      seq: 2,
      speaker: "agent",
      text: "Thanks, I will send details to ada@example.com about code 4421.",
      spokenText: "Thanks, I will send details to ada@example.com.",
      language: "en-NG",
      interrupted: false,
      llmModel: "muse-spark-1.3-contributor",
      ttsModelId: "cartesia-sonic",
      timingsMs: { llm_first_token: 300, tts_first_audio: 200 },
    });

    await store.endInteraction(tenantId, interactionId, "caller_hangup");

    // Read back through the tenant scope: PII must be redacted on disk.
    const rawInteractionId = toRawId(interactionId, "int");
    const stored = await service.withTenant(tenantId, async (tx) => ({
      interaction: (
        await tx.select().from(interactions).where(eq(interactions.id, rawInteractionId)).limit(1)
      )[0],
      turnRows: await tx.select().from(turns).where(eq(turns.interactionId, rawInteractionId)),
    }));

    expect(stored.interaction?.status).toBe("closed");
    expect(stored.interaction?.recordingState).toBe("recording");
    expect(stored.interaction?.noticeBlockId).toBe("recording_notice");

    const bySeq = new Map(stored.turnRows.map((t) => [t.seq, t]));
    expect(bySeq.get(1)?.text).toBe("my card is [CARD] and call [PHONE]");
    expect(bySeq.get(2)?.text).toBe(
      "Thanks, I will send details to [EMAIL] about code [OTP].",
    );
    expect(bySeq.get(2)?.spokenText).toBe("Thanks, I will send details to [EMAIL].");
  });

  it("persists compliance flags on endInteraction (M21)", async () => {
    const { interactionId } = await store.startInteraction({
      tenantId,
      agentId,
      channel: "web_voice",
      direction: "inbound",
    });
    await store.endInteraction(tenantId, interactionId, "error", {
      complianceFlags: ["notice_failed"],
    });
    const rawId = toRawId(interactionId, "int");
    const stored = await service.withTenant(tenantId, async (tx) => ({
      interaction: (
        await tx.select().from(interactions).where(eq(interactions.id, rawId)).limit(1)
      )[0],
    }));
    expect(stored.interaction?.endReason).toBe("error");
    expect(stored.interaction?.complianceFlags).toEqual(["notice_failed"]);
  });

  it("refuses another tenant's agent", async () => {
    const other = await createTenantWithAgent(service, "Other Tenant Ltd");
    try {
      await expect(
        store.startInteraction({
          tenantId,
          agentId: other.agentId,
          channel: "web_voice",
          direction: "inbound",
        }),
      ).rejects.toThrow("Agent not found");
    } finally {
      await deleteTenantData(service, other.tenantId).catch(() => undefined);
    }
  });
});
