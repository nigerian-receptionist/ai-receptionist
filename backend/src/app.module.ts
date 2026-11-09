import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
