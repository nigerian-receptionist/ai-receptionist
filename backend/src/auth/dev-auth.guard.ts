import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { resolveDevPrincipal, type Principal } from "./dev-auth";

interface GuardRequest {
  headers: { authorization?: string };
  principal?: Principal;
}

/** Reads `Authorization: Bearer <token>` and resolves the dev principal. */
@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<GuardRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const principal = resolveDevPrincipal(token, this.env);
    if (principal === null) throw new UnauthorizedException("Invalid or missing bearer token");
    req.principal = principal;
    return true;
  }
}
