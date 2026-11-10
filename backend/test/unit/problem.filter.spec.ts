import type { ArgumentsHost } from "@nestjs/common";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { InvalidCursorError, NotFoundError } from "../../src/common/errors";
import { ProblemJsonFilter } from "../../src/common/problem.filter";

function run(exception: unknown) {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: (code: number) => {
      statusCode = code;
      return {
        json: (payload: Record<string, unknown>) => {
          body = payload;
        },
      };
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: "/v1/x" }) }),
  } as unknown as ArgumentsHost;
  new ProblemJsonFilter().catch(exception, host);
  return { statusCode, body, headers };
}

describe("ProblemJsonFilter stable types (M35)", () => {
  it("maps ProblemError to its stable urn type", () => {
    const { statusCode, body, headers } = run(new InvalidCursorError());
    expect(statusCode).toBe(400);
    expect(body.type).toBe("urn:ai-receptionist:invalid-cursor");
    expect(body.title).toBe("Bad Request");
    expect(body.detail).toBe("Invalid cursor");
    expect(body.instance).toBe("/v1/x");
    expect(headers["content-type"]).toBe("application/problem+json");
  });

  it("maps NotFoundError to not-found", () => {
    const { statusCode, body } = run(new NotFoundError("interaction"));
    expect(statusCode).toBe(404);
    expect(body.type).toBe("urn:ai-receptionist:not-found");
  });

  it("maps Nest HttpExceptions to stable types by status", () => {
    expect(run(new NotFoundException("gone")).body.type).toBe("urn:ai-receptionist:not-found");
    expect(run(new BadRequestException("bad")).body.type).toBe("urn:ai-receptionist:bad-request");
  });

  it("maps ZodError to invalid-request", () => {
    const err = z.object({ limit: z.number() }).safeParse({ limit: "x" });
    expect(err.success).toBe(false);
    if (err.success) return;
    const { statusCode, body } = run(err.error);
    expect(statusCode).toBe(400);
    expect(body.type).toBe("urn:ai-receptionist:invalid-request");
    expect(body.detail).toContain("limit");
  });

  it("maps unexpected errors to internal-error with no detail", () => {
    const { statusCode, body } = run(new Error("db connection string host=db.internal exploded"));
    expect(statusCode).toBe(500);
    expect(body.type).toBe("urn:ai-receptionist:internal-error");
    expect(body.detail).toBeUndefined();
  });
});
