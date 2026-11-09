"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteractionsController = void 0;
const common_1 = require("@nestjs/common");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const dev_auth_guard_1 = require("../auth/dev-auth.guard");
const principal_1 = require("../auth/principal");
const cursor_1 = require("../common/cursor");
const db_service_1 = require("../db/db.service");
const schema_1 = require("../db/schema");
const ids_1 = require("./ids");
const listQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    cursor: zod_1.z.string().min(1).optional(),
});
const idParamSchema = zod_1.z.object({ id: zod_1.z.string().min(1) });
function toInteractionDto(row) {
    return {
        id: (0, ids_1.toPublicId)("int", row.id),
        agentId: (0, ids_1.toPublicId)("agt", row.agentId),
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
function toTurnDto(row) {
    return {
        id: (0, ids_1.toPublicId)("trn", row.id),
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
let InteractionsController = class InteractionsController {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Newest first by UUIDv7 id (creation order), keyset-paginated, stable. */
    async list(principal, query) {
        const { limit, cursor } = listQuerySchema.parse(query);
        const decoded = cursor === undefined ? null : (0, cursor_1.decodeCursor)(cursor);
        if (cursor !== undefined && decoded === null)
            throw new common_1.BadRequestException("Invalid cursor");
        const rows = await this.db.withTenant(principal.tenantId, async (tx) => tx
            .select()
            .from(schema_1.interactions)
            .where(decoded === null ? undefined : (0, drizzle_orm_1.lt)(schema_1.interactions.id, decoded.id))
            .orderBy((0, drizzle_orm_1.desc)(schema_1.interactions.id))
            .limit(limit + 1));
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
            data: page.map(toInteractionDto),
            nextCursor: rows.length > limit && last !== undefined ? (0, cursor_1.encodeCursor)({ id: last.id }) : null,
        };
    }
    async getOne(principal, params) {
        const { id } = idParamSchema.parse(params);
        let rawId;
        try {
            rawId = (0, ids_1.toRawId)(id, "int");
        }
        catch {
            throw new common_1.BadRequestException("Invalid interaction id");
        }
        const result = await this.db.withTenant(principal.tenantId, async (tx) => {
            const found = await tx
                .select()
                .from(schema_1.interactions)
                .where((0, drizzle_orm_1.eq)(schema_1.interactions.id, rawId))
                .limit(1);
            const interaction = found[0];
            if (interaction === undefined)
                return null;
            const turnRows = await tx
                .select()
                .from(schema_1.turns)
                .where((0, drizzle_orm_1.eq)(schema_1.turns.interactionId, rawId))
                .orderBy(schema_1.turns.seq);
            return { interaction, turnRows };
        });
        if (result === null)
            throw new common_1.NotFoundException("Interaction not found");
        return { ...toInteractionDto(result.interaction), turns: result.turnRows.map(toTurnDto) };
    }
};
exports.InteractionsController = InteractionsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, principal_1.Principal)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], InteractionsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(":id"),
    __param(0, (0, principal_1.Principal)()),
    __param(1, (0, common_1.Param)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], InteractionsController.prototype, "getOne", null);
exports.InteractionsController = InteractionsController = __decorate([
    (0, common_1.Controller)("v1/interactions"),
    (0, common_1.UseGuards)(dev_auth_guard_1.DevAuthGuard),
    __metadata("design:paramtypes", [db_service_1.DbService])
], InteractionsController);
//# sourceMappingURL=interactions.controller.js.map