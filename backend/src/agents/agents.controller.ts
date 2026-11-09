import { Controller, Get, UseGuards } from "@nestjs/common";

import { DevAuthGuard } from "../auth/dev-auth.guard";
import type { Principal as DevPrincipal } from "../auth/dev-auth";
import { Principal } from "../auth/principal";
import { DbService } from "../db/db.service";
import { agents } from "../db/schema";
import { toPublicId } from "../interactions/ids";

@Controller("v1/agents")
@UseGuards(DevAuthGuard)
export class AgentsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Principal() principal: DevPrincipal): Promise<
    Array<{ id: string; name: string; language: string; status: string }>
  > {
    const rows = await this.db.withTenant(principal.tenantId, async (tx) =>
      tx.select().from(agents).orderBy(agents.createdAt),
    );
    return rows.map((a) => ({
      id: toPublicId("agt", a.id),
      name: a.name,
      language: a.language,
      status: a.status,
    }));
  }
}
