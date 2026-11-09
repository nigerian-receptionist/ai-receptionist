import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import type { Principal as DevPrincipal } from "./dev-auth";

/** Extracts the principal set by DevAuthGuard. */
export const Principal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DevPrincipal => {
    const req = ctx.switchToHttp().getRequest<{ principal?: DevPrincipal }>();
    if (req.principal === undefined) throw new Error("Missing principal: DevAuthGuard not applied");
    return req.principal;
  },
);
