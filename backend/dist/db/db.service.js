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
exports.DbService = void 0;
const common_1 = require("@nestjs/common");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const tenantIdSchema = zod_1.z.string().uuid();
/**
 * Tenant-scoped database access. Every tenant query runs inside `withTenant`,
 * which opens a transaction and sets `app.tenant_id` so RLS policies apply.
 * With no tenant set the app role sees zero rows (verified by leak tests).
 */
let DbService = class DbService {
    pool;
    db;
    constructor(pool, db) {
        this.pool = pool;
        this.db = db;
    }
    async withTenant(tenantId, fn) {
        const tenant = tenantIdSchema.parse(tenantId);
        return this.db.transaction(async (tx) => {
            await tx.execute((0, drizzle_orm_1.sql) `SELECT set_config('app.tenant_id', ${tenant}, true)`);
            return fn(tx);
        });
    }
    /** Unscoped query for health checks only; never for tenant data. */
    async checkConnection() {
        await this.db.execute((0, drizzle_orm_1.sql) `SELECT 1`);
    }
    async onModuleDestroy() {
        await this.pool.end().catch(() => undefined);
    }
};
exports.DbService = DbService;
exports.DbService = DbService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [Function, Object])
], DbService);
//# sourceMappingURL=db.service.js.map