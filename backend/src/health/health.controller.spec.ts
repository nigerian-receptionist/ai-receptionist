import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { DbService } from "../db/db.service";
import { HealthController } from "./health.controller";

function controller(checkConnection: () => Promise<void>): HealthController {
  return new HealthController({ checkConnection } as unknown as DbService);
}

describe("HealthController", () => {
  it("reports ok", () => {
    expect(controller(async () => undefined).health()).toEqual({
      status: "ok",
      service: "ai-receptionist-api",
    });
  });

  it("is ready when Postgres answers", async () => {
    await expect(controller(async () => undefined).ready()).resolves.toEqual({ status: "ok" });
  });

  it("is not ready when Postgres is down", async () => {
    const failing = controller(async () => {
      throw new Error("down");
    });
    await expect(failing.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
