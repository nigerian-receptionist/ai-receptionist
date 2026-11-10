import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { ZodError } from "zod";

import { PROBLEM_BASE, ProblemError } from "./errors";

interface ProblemResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** Stable `type` ids per status for non-domain errors (AGENTS.md 8.3, M35). */
const TYPE_BY_STATUS: Record<number, string> = {
  400: "bad-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  422: "unprocessable-entity",
  500: "internal-error",
  503: "service-unavailable",
};

/**
 * Single error filter: every error leaves the API as RFC 9457
 * `application/problem+json`. Unexpected errors are logged server-side without
 * leaking internals to the client.
 */
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<ProblemResponse>();
    const req = ctx.getRequest<{ url?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let type = `${PROBLEM_BASE}:internal-error`;
    let detail: string | undefined;

    if (exception instanceof ProblemError) {
      status = exception.status;
      type = exception.problemType;
      detail = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      type = `${PROBLEM_BASE}:${TYPE_BY_STATUS[status] ?? "error"}`;
      const body = exception.getResponse();
      detail =
        typeof body === "string"
          ? body
          : Array.isArray((body as { message?: unknown }).message)
            ? ((body as { message: string[] }).message.join("; ") ?? exception.message)
            : ((body as { message?: string }).message ?? exception.message);
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      type = `${PROBLEM_BASE}:invalid-request`;
      detail = exception.issues
        .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
        .join("; ");
    } else {
      console.error(exception);
    }

    res.setHeader("content-type", "application/problem+json");
    res.status(status).json({
      type,
      title: TITLES[status] ?? "Error",
      status,
      ...(detail === undefined ? {} : { detail }),
      ...(req.url === undefined ? {} : { instance: req.url }),
    });
  }
}
