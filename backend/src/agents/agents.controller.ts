import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { asc, gt } from "drizzle-orm";
import { z } from "zod";

import { DevAuthGuard } from "../auth/dev-auth.guard";
import type { Principal as DevPrincipal } from "../auth/dev-auth";
import { Principal } from "../auth/principal";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { InvalidCursorError } from "../common/errors";
import { DbService } from "../db/db.service";
import { agents } from "../db/schema";
import { toPublicId } from "../interactions/ids";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

@Controller("v1/agents")
@UseGuards(DevAuthGuard)
export class AgentsController {
  // M6: explicit token — tsx/esbuild emit no decorator metadata.
  constructor(@Inject(DbService) private readonly db: DbService) {}

  /** Oldest first by UUIDv7 id (creation order), keyset-paginated, stable. */
  @Get()
  async list(@Principal() principal: DevPrincipal, @Query() query: unknown) {
    const { limit, cursor } = listQuerySchema.parse(query);
    const decoded = cursor === undefined ? null : decodeCursor(cursor);
    if (cursor !== undefined && decoded === null) throw new InvalidCursorError();

    const rows = await this.db.withTenant(principal.tenantId, async (tx) =>
      tx
        .select()
        .from(agents)
        .where(decoded === null ? undefined : gt(agents.id, decoded.id))
        .orderBy(asc(agents.id))
        .limit(limit + 1),
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((a) => ({
        id: toPublicId("agt", a.id),
        name: a.name,
        language: a.language,
        status: a.status,
      })),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ id: last.id }) : null,
    };
  }
}
