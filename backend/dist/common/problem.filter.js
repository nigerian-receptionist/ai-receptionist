"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProblemJsonFilter = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const TITLES = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    500: "Internal Server Error",
    503: "Service Unavailable",
};
/**
 * Single error filter: every error leaves the API as RFC 9457
 * `application/problem+json`. Unexpected errors are logged server-side without
 * leaking internals to the client.
 */
let ProblemJsonFilter = class ProblemJsonFilter {
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const res = ctx.getResponse();
        const req = ctx.getRequest();
        let status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
        let detail;
        if (exception instanceof common_1.HttpException) {
            status = exception.getStatus();
            const body = exception.getResponse();
            detail =
                typeof body === "string"
                    ? body
                    : Array.isArray(body.message)
                        ? (body.message.join("; ") ?? exception.message)
                        : (body.message ?? exception.message);
        }
        else if (exception instanceof zod_1.ZodError) {
            status = common_1.HttpStatus.BAD_REQUEST;
            detail = exception.issues
                .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
                .join("; ");
        }
        else {
            console.error(exception);
        }
        res.setHeader("content-type", "application/problem+json");
        res.status(status).json({
            type: "about:blank",
            title: TITLES[status] ?? "Error",
            status,
            ...(detail === undefined ? {} : { detail }),
            ...(req.url === undefined ? {} : { instance: req.url }),
        });
    }
};
exports.ProblemJsonFilter = ProblemJsonFilter;
exports.ProblemJsonFilter = ProblemJsonFilter = __decorate([
    (0, common_1.Catch)()
], ProblemJsonFilter);
//# sourceMappingURL=problem.filter.js.map