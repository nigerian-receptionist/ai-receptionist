import { Global, Inject, Module, OnModuleInit } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DbService, type AppDb } from "./db.service";
import { assertRlsEnforced } from "./rls-check";
import * as schema from "./schema";

export const DB_POOL = Symbol("DB_POOL");
export const DB = Symbol("DB");

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [ENV],
      useFactory: (env: Env): Pool => new Pool({ connectionString: env.DATABASE_URL }),
    },
    {
      provide: DB,
      inject: [DB_POOL],
      useFactory: (pool: Pool): AppDb => drizzle(pool, { schema }),
    },
    {
      provide: DbService,
      inject: [DB_POOL, DB],
      useFactory: (pool: Pool, db: AppDb): DbService => new DbService(pool, db),
    },
  ],
  exports: [DbService],
})
export class DbModule implements OnModuleInit {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {
    // Prevent idle-client errors from crashing the process; per-query errors
    // still reject the awaiting caller.
    pool.on("error", () => undefined);
  }

  async onModuleInit(): Promise<void> {
    // M24: refuse to serve when tenant isolation cannot hold. Skipped only
    // under the test runners (NODE_ENV=test); the check itself is covered by
    // integration tests against the real database.
    if (process.env.NODE_ENV === "test") return;
    await assertRlsEnforced(this.pool);
  }
}
