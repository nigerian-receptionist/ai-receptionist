import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  /** Reports that the process responds; this is not a dependency check. */
  @Get(["health", "v1/health"])
  health(): { status: string; service: string } {
    return { status: "ok", service: "ai-receptionist-api" };
  }
}
