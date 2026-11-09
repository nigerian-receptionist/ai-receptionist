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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DrizzleInteractionStore = void 0;
const common_1 = require("@nestjs/common");
const drizzle_orm_1 = require("drizzle-orm");
const uuidv7_1 = require("../common/uuidv7");
const db_service_1 = require("../db/db.service");
const schema_1 = require("../db/schema");
const redact_1 = require("../privacy/redact");
const ids_1 = require("./ids");
const RECORDING_STATES = [
    "not_started",
    "notice_playing",
    "notice_confirmed",
    "recording",
];
const END_REASONS = ["caller_hangup", "agent_ended", "error", "timeout"];
/**
 * Postgres-backed InteractionStore. Every call runs inside `withTenant` (RLS),
 * and turn text is redacted before insert. Never logs turn text.
 */
let DrizzleInteractionStore = class DrizzleInteractionStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async startInteraction(input) {
        const agentRawId = (0, ids_1.toRawId)(input.agentId, "agt");
        return this.db.withTenant(input.tenantId, async (tx) => {
            const found = await tx
                .select({ id: schema_1.agents.id })
                .from(schema_1.agents)
                .where((0, drizzle_orm_1.eq)(schema_1.agents.id, agentRawId))
                .limit(1);
            if (found.length === 0)
                throw new Error("Agent not found");
            const id = (0, uuidv7_1.uuidv7)();
            await tx.insert(schema_1.interactions).values({
                id,
                tenantId: input.tenantId,
                agentId: agentRawId,
                channel: input.channel,
                direction: input.direction,
                status: "open",
                recordingState: "not_started",
            });
            return { interactionId: (0, ids_1.toPublicId)("int", id) };
        });
    }
    async setRecordingState(tenantId, interactionId, state, noticeProof) {
        if (!RECORDING_STATES.includes(state))
            throw new Error("Invalid recording state");
        const rawId = (0, ids_1.toRawId)(interactionId, "int");
        await this.db.withTenant(tenantId, async (tx) => {
            const updated = await tx
                .update(schema_1.interactions)
                .set({
                recordingState: state,
                noticeBlockId: noticeProof?.blockId,
                noticeBlockVersion: noticeProof?.blockVersion,
                noticeBlockHash: noticeProof?.blockHash,
                noticeDeliveredAt: noticeProof?.deliveredAt,
                updatedAt: new Date(),
            })
                .where((0, drizzle_orm_1.eq)(schema_1.interactions.id, rawId))
                .returning({ id: schema_1.interactions.id });
            if (updated.length === 0)
                throw new Error("Interaction not found");
        });
    }
    async appendTurn(tenantId, turn) {
        const interactionRawId = (0, ids_1.toRawId)(turn.interactionId, "int");
        return this.db.withTenant(tenantId, async (tx) => {
            const found = await tx
                .select({ id: schema_1.interactions.id })
                .from(schema_1.interactions)
                .where((0, drizzle_orm_1.eq)(schema_1.interactions.id, interactionRawId))
                .limit(1);
            if (found.length === 0)
                throw new Error("Interaction not found");
            const id = (0, uuidv7_1.uuidv7)();
            await tx.insert(schema_1.turns).values({
                id,
                tenantId,
                interactionId: interactionRawId,
                seq: turn.seq,
                speaker: turn.speaker,
                text: (0, redact_1.redact)(turn.text),
                spokenText: turn.spokenText === undefined ? undefined : (0, redact_1.redact)(turn.spokenText),
                language: turn.language,
                interrupted: turn.interrupted,
                sttModelId: turn.sttModelId,
                sttConfidence: turn.sttConfidence ?? null,
                llmModel: turn.llmModel,
                ttsModelId: turn.ttsModelId,
                voiceId: turn.voiceId,
                blockId: turn.blockId,
                blockVersion: turn.blockVersion,
                blockHash: turn.blockHash,
                timingsMs: turn.timingsMs,
                tokens: turn.tokens ?? null,
            });
            return { turnId: (0, ids_1.toPublicId)("trn", id) };
        });
    }
    async endInteraction(tenantId, interactionId, endReason) {
        if (!END_REASONS.includes(endReason))
            throw new Error("Invalid end reason");
        const rawId = (0, ids_1.toRawId)(interactionId, "int");
        await this.db.withTenant(tenantId, async (tx) => {
            const updated = await tx
                .update(schema_1.interactions)
                .set({
                status: "closed",
                endReason,
                endedAt: new Date(),
                updatedAt: new Date(),
            })
                .where((0, drizzle_orm_1.eq)(schema_1.interactions.id, rawId))
                .returning({ id: schema_1.interactions.id });
            if (updated.length === 0)
                throw new Error("Interaction not found");
        });
    }
    async getAgentForSession(tenantId, agentId) {
        return this.db.withTenant(tenantId, async (tx) => {
            const rows = agentId === undefined
                ? await tx.select().from(schema_1.agents).orderBy(schema_1.agents.createdAt).limit(1)
                : await tx.select().from(schema_1.agents).where((0, drizzle_orm_1.eq)(schema_1.agents.id, (0, ids_1.toRawId)(agentId, "agt"))).limit(1);
            const agent = rows[0];
            if (agent === undefined)
                throw new Error("Agent not found");
            const tenantRows = await tx
                .select({ name: schema_1.tenants.name })
                .from(schema_1.tenants)
                .where((0, drizzle_orm_1.eq)(schema_1.tenants.id, tenantId))
                .limit(1);
            const tenant = tenantRows[0];
            if (tenant === undefined)
                throw new Error("Tenant not found");
            return {
                agentId: (0, ids_1.toPublicId)("agt", agent.id),
                orgName: tenant.name,
                personaPrompt: agent.personaPrompt,
                voiceId: agent.voiceId,
                language: agent.language,
            };
        });
    }
};
exports.DrizzleInteractionStore = DrizzleInteractionStore;
exports.DrizzleInteractionStore = DrizzleInteractionStore = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [db_service_1.DbService])
], DrizzleInteractionStore);
//# sourceMappingURL=drizzle-store.js.map