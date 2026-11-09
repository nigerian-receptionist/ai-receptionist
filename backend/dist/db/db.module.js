"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DbModule = exports.DB = exports.DB_POOL = void 0;
const common_1 = require("@nestjs/common");
const node_postgres_1 = require("drizzle-orm/node-postgres");
const pg_1 = require("pg");
const config_module_1 = require("../config/config.module");
const db_service_1 = require("./db.service");
const schema = __importStar(require("./schema"));
exports.DB_POOL = Symbol("DB_POOL");
exports.DB = Symbol("DB");
let DbModule = class DbModule {
    constructor(pool) {
        // Prevent idle-client errors from crashing the process; per-query errors
        // still reject the awaiting caller.
        pool.on("error", () => undefined);
    }
};
exports.DbModule = DbModule;
exports.DbModule = DbModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        providers: [
            {
                provide: exports.DB_POOL,
                inject: [config_module_1.ENV],
                useFactory: (env) => new pg_1.Pool({ connectionString: env.DATABASE_URL }),
            },
            {
                provide: exports.DB,
                inject: [exports.DB_POOL],
                useFactory: (pool) => (0, node_postgres_1.drizzle)(pool, { schema }),
            },
            {
                provide: db_service_1.DbService,
                inject: [exports.DB_POOL, exports.DB],
                useFactory: (pool, db) => new db_service_1.DbService(pool, db),
            },
        ],
        exports: [exports.DB_POOL, exports.DB, db_service_1.DbService],
    }),
    __param(0, (0, common_1.Inject)(exports.DB_POOL)),
    __metadata("design:paramtypes", [pg_1.Pool])
], DbModule);
//# sourceMappingURL=db.module.js.map