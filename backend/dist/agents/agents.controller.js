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
exports.AgentsController = void 0;
const common_1 = require("@nestjs/common");
const dev_auth_guard_1 = require("../auth/dev-auth.guard");
const principal_1 = require("../auth/principal");
const db_service_1 = require("../db/db.service");
const schema_1 = require("../db/schema");
const ids_1 = require("../interactions/ids");
let AgentsController = class AgentsController {
    db;
    constructor(db) {
        this.db = db;
    }
    async list(principal) {
        const rows = await this.db.withTenant(principal.tenantId, async (tx) => tx.select().from(schema_1.agents).orderBy(schema_1.agents.createdAt));
        return rows.map((a) => ({
            id: (0, ids_1.toPublicId)("agt", a.id),
            name: a.name,
            language: a.language,
            status: a.status,
        }));
    }
};
exports.AgentsController = AgentsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, principal_1.Principal)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "list", null);
exports.AgentsController = AgentsController = __decorate([
    (0, common_1.Controller)("v1/agents"),
    (0, common_1.UseGuards)(dev_auth_guard_1.DevAuthGuard),
    __metadata("design:paramtypes", [db_service_1.DbService])
], AgentsController);
//# sourceMappingURL=agents.controller.js.map