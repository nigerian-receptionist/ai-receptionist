import {
  CanActivate,
  ExecutionContext,
  Global,
  INestApplication,
  Injectable,
  Module,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AgentsController } from "../../src/agents/agents.controller";
import { DevAuthGuard } from "../../src/auth/dev-auth.guard";
import { ENV } from "../../src/config/config.module";
import { ProblemJsonFilter } from "../../src/common/problem.filter";
import { DbModule } from "../../src/db/db.module";
import { DbService } from "../../src/db/db.service";
import { DrizzleInteractionStore } from "../../src/interactions/drizzle-store";
import { InteractionsController } from "../../src/interactions/interactions.controller";
import {
  createTenantAgent,
  createTenantWithAgent,
  createTestDb,
  deleteTenantData,
} from "../helpers/db";

/**
 * HTTP-level API tests against real Postgres (F9.4, F9.2, M35): boots the
 * controllers with a stub guard that maps bearer tokens to tenants.
 */
describe("HTTP API (real Postgres, stub guard)", () => {
  let app: INestApplication;
  let pool: Pool;
  let owner: Pool;
  let service: DbService;
  let store: DrizzleInteractionStore;
  let a: { tenantId: string; agentId: string };
  let b: { tenantId: string; agentId: string };
  let aInteraction: string;

  const tenantsByToken = new Map<string, string>();

  @Injectable()
  class StubGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<{
        headers: { authorization?: string };
        principal?: { tenantId: string };
      }>();
      const header = req.headers.authorization;
      const token =
        header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
      const tenantId = token === undefined ? undefined : tenantsByToken.get(token);
      if (tenantId === undefined) return false;
      req.principal = { tenantId };
      return true;
    }
  }

  beforeAll(async () => {
    ({ pool, owner, service, store } = createTestDb());
    a = await createTenantWithAgent(service, "http tenant a");
    b = await createTenantWithAgent(service, "http tenant b");
    await createTenantAgent(service, a.tenantId, "http tenant a second");
    await createTenantAgent(service, a.tenantId, "http tenant a third");
    ({ interactionId: aInteraction } = await store.startInteraction({
      tenantId: a.tenantId,
      agentId: a.agentId,
      channel: "web_voice",
      direction: "inbound",
    }));
    tenantsByToken.set("token-a", a.tenantId);
    tenantsByToken.set("token-b", b.tenantId);

    @Global()
    @Module({
      providers: [{ provide: ENV, useValue: { DATABASE_URL: process.env.DATABASE_URL } }],
      exports: [ENV],
    })
    class TestEnvModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [TestEnvModule, DbModule],
      controllers: [AgentsController, InteractionsController],
      providers: [{ provide: APP_FILTER, useClass: ProblemJsonFilter }],
    })
      .overrideGuard(DevAuthGuard)
      .useClass(StubGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await deleteTenantData(owner, a.tenantId).catch(() => undefined);
    await deleteTenantData(owner, b.tenantId).catch(() => undefined);
    await pool.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  });

  const get = (url: string, token: string) =>
    request(app.getHttpServer()).get(url).set("Authorization", `Bearer ${token}`);

  it("paginates GET /v1/agents with limit/cursor (F9.2)", async () => {
    const first = await get("/v1/agents?limit=2", "token-a").expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0]).toMatchObject({ name: "http tenant a agent" });
    expect(typeof first.body.nextCursor).toBe("string");

    const second = await get(`/v1/agents?limit=2&cursor=${first.body.nextCursor}`, "token-a")
      .expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0]).toMatchObject({ name: "http tenant a third" });
    expect(second.body.nextCursor).toBeNull();
  });

  it("scopes GET /v1/agents to the calling tenant (F9.4)", async () => {
    const res = await get("/v1/agents", "token-b").expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ name: "http tenant b agent" });
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns 404 not-found for another tenant's interaction (F9.4)", async () => {
    const cross = await get(`/v1/interactions/${aInteraction}`, "token-b").expect(404);
    expect(cross.body.type).toBe("urn:ai-receptionist:not-found");
    expect(cross.headers["content-type"]).toContain("application/problem+json");

    const own = await get(`/v1/interactions/${aInteraction}`, "token-a").expect(200);
    expect(own.body.id).toBe(aInteraction);
  });

  it("returns 404 not-found for a missing interaction", async () => {
    const res = await get("/v1/interactions/int_0195f3a0-0000-7000-8000-000000000099", "token-a")
      .expect(404);
    expect(res.body.type).toBe("urn:ai-receptionist:not-found");
  });

  it("returns stable problem types for bad cursor and bad id (M35)", async () => {
    const badCursor = await get("/v1/agents?cursor=!!!not-a-cursor!!!", "token-a").expect(400);
    expect(badCursor.body.type).toBe("urn:ai-receptionist:invalid-cursor");

    const badId = await get("/v1/interactions/bogus-id", "token-a").expect(400);
    expect(badId.body.type).toBe("urn:ai-receptionist:invalid-id");
  });
});
