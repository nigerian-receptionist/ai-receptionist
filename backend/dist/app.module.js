"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const agents_controller_1 = require("./agents/agents.controller");
const problem_filter_1 = require("./common/problem.filter");
const config_module_1 = require("./config/config.module");
const db_module_1 = require("./db/db.module");
const health_controller_1 = require("./health/health.controller");
const interactions_controller_1 = require("./interactions/interactions.controller");
const interactions_module_1 = require("./interactions/interactions.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [config_module_1.ConfigModule, db_module_1.DbModule, interactions_module_1.InteractionsModule],
        controllers: [health_controller_1.HealthController, agents_controller_1.AgentsController, interactions_controller_1.InteractionsController],
        providers: [{ provide: core_1.APP_FILTER, useClass: problem_filter_1.ProblemJsonFilter }],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map