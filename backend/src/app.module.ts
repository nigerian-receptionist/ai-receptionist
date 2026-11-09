import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";
import { INTERACTION_STORE } from "./interactions/interaction-store";
import { InMemoryInteractionStore } from "./voice/testing/in-memory-interaction-store";
import { VoiceModule } from "./voice/voice.module";

@Module({
  imports: [ConfigModule, VoiceModule],
  controllers: [HealthController],
  providers: [
    // TODO(merge): replace with InteractionsModule (Postgres) when the data-layer agent lands it.
    { provide: INTERACTION_STORE, useClass: InMemoryInteractionStore },
  ],
})
export class AppModule {}
