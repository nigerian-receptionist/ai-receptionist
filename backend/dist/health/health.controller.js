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
exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const db_service_1 = require("../db/db.service");
let HealthController = class HealthController {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Reports that the process responds; this is not a dependency check. */
    health() {
        return { status: "ok", service: "ai-receptionist-api" };
    }
    /** Readiness: 200 when Postgres answers, 503 otherwise. Unauthenticated. */
    async ready() {
        try {
            await this.db.checkConnection();
        }
        catch {
            throw new common_1.ServiceUnavailableException("Database unreachable");
        }
        return { status: "ok" };
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, common_1.Get)(["health", "v1/health"]),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], HealthController.prototype, "health", null);
__decorate([
    (0, common_1.Get)("v1/ready"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "ready", null);
exports.HealthController = HealthController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [db_service_1.DbService])
], HealthController);
//# sourceMappingURL=health.controller.js.map