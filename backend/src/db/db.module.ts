import { Global, Inject, Module } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DbService, type AppDb } from "./db.service";
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
export class DbModule {
  constructor(@Inject(DB_POOL) pool: Pool) {
    // Prevent idle-client errors from crashing the process; per-query errors
    // still reject the awaiting caller.
    pool.on("error", () => undefined);
  }
}
