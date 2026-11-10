import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";

import { DbService } from "../db/db.service";

@Controller()
export class HealthController {
  // M6: explicit token — tsx/esbuild emit no decorator metadata.
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Reports that the process responds; this is not a dependency check. */
  @Get(["health", "v1/health"])
  health(): { status: string; service: string } {
    return { status: "ok", service: "ai-receptionist-api" };
  }

  /** Readiness: 200 when Postgres answers, 503 otherwise. Unauthenticated. */
  @Get("v1/ready")
  async ready(): Promise<{ status: string }> {
    try {
      await this.db.checkConnection();
    } catch {
      throw new ServiceUnavailableException("Database unreachable");
    }
    return { status: "ok" };
  }
}
