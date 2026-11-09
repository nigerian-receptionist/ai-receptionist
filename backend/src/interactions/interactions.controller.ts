import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { DevAuthGuard } from "../auth/dev-auth.guard";
import type { Principal as DevPrincipal } from "../auth/dev-auth";
import { Principal } from "../auth/principal";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { DbService } from "../db/db.service";
import { interactions, turns, type InteractionRow, type TurnRow } from "../db/schema";
import { toPublicId, toRawId } from "./ids";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const idParamSchema = z.object({ id: z.string().min(1) });

function toInteractionDto(row: InteractionRow) {
  return {
    id: toPublicId("int", row.id),
    agentId: toPublicId("agt", row.agentId),
    contactId: row.contactId,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    endReason: row.endReason,
    recordingState: row.recordingState,
    noticeBlockId: row.noticeBlockId,
    noticeBlockVersion: row.noticeBlockVersion,
    noticeBlockHash: row.noticeBlockHash,
    noticeDeliveredAt: row.noticeDeliveredAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
  };
}

function toTurnDto(row: TurnRow) {
  return {
    id: toPublicId("trn", row.id),
    seq: row.seq,
    speaker: row.speaker,
    text: row.text,
    spokenText: row.spokenText,
    language: row.language,
    interrupted: row.interrupted,
    sttModelId: row.sttModelId,
    sttConfidence: row.sttConfidence,
    llmModel: row.llmModel,
    ttsModelId: row.ttsModelId,
    voiceId: row.voiceId,
    blockId: row.blockId,
    blockVersion: row.blockVersion,
    blockHash: row.blockHash,
    timingsMs: row.timingsMs,
    tokens: row.tokens,
  };
}

@Controller("v1/interactions")
@UseGuards(DevAuthGuard)
export class InteractionsController {
  constructor(private readonly db: DbService) {}

  /** Newest first by UUIDv7 id (creation order), keyset-paginated, stable. */
  @Get()
  async list(@Principal() principal: DevPrincipal, @Query() query: unknown) {
    const { limit, cursor } = listQuerySchema.parse(query);
    const decoded = cursor === undefined ? null : decodeCursor(cursor);
    if (cursor !== undefined && decoded === null) throw new BadRequestException("Invalid cursor");

    const rows = await this.db.withTenant(principal.tenantId, async (tx) =>
      tx
        .select()
        .from(interactions)
        .where(decoded === null ? undefined : lt(interactions.id, decoded.id))
        .orderBy(desc(interactions.id))
        .limit(limit + 1),
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map(toInteractionDto),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor({ id: last.id }) : null,
    };
  }

  @Get(":id")
  async getOne(@Principal() principal: DevPrincipal, @Param() params: unknown) {
    const { id } = idParamSchema.parse(params);
    let rawId: string;
    try {
      rawId = toRawId(id, "int");
    } catch {
      throw new BadRequestException("Invalid interaction id");
    }

    const result = await this.db.withTenant(principal.tenantId, async (tx) => {
      const found = await tx
        .select()
        .from(interactions)
        .where(eq(interactions.id, rawId))
        .limit(1);
      const interaction = found[0];
      if (interaction === undefined) return null;
      const turnRows = await tx
        .select()
        .from(turns)
        .where(eq(turns.interactionId, rawId))
        .orderBy(turns.seq);
      return { interaction, turnRows };
    });

    if (result === null) throw new NotFoundException("Interaction not found");
    return { ...toInteractionDto(result.interaction), turns: result.turnRows.map(toTurnDto) };
  }
}
