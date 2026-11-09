import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { z } from "zod";

import * as schema from "./schema";

export type AppDb = NodePgDatabase<typeof schema>;
export type TenantTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

const tenantIdSchema = z.string().uuid();

/**
 * Tenant-scoped database access. Every tenant query runs inside `withTenant`,
 * which opens a transaction and sets `app.tenant_id` so RLS policies apply.
 * With no tenant set the app role sees zero rows (verified by leak tests).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  constructor(
    readonly pool: Pool,
    readonly db: AppDb,
  ) {}

  async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tenant = tenantIdSchema.parse(tenantId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant}, true)`);
      return fn(tx);
    });
  }

  /** Unscoped query for health checks only; never for tenant data. */
  async checkConnection(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
