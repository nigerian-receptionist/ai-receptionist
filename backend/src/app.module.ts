import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";
import { InMemoryInteractionStore } from "./voice/testing/in-memory-interaction-store";
import { VoiceModule } from "./voice/voice.module";

@Module({
  imports: [
    ConfigModule,
    // TODO(merge): replace the in-memory store with InteractionsModule (Postgres)
    // when the data-layer agent lands it.
    VoiceModule.register({ store: InMemoryInteractionStore }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
