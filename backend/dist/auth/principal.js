"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Principal = void 0;
const common_1 = require("@nestjs/common");
/** Extracts the principal set by DevAuthGuard. */
exports.Principal = (0, common_1.createParamDecorator)((_data, ctx) => {
    const req = ctx.switchToHttp().getRequest();
    if (req.principal === undefined)
        throw new Error("Missing principal: DevAuthGuard not applied");
    return req.principal;
});
//# sourceMappingURL=principal.js.map