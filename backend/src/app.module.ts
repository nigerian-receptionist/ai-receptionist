import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { AgentsController } from "./agents/agents.controller";
import { ProblemJsonFilter } from "./common/problem.filter";
import { ConfigModule } from "./config/config.module";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health/health.controller";
import { DrizzleInteractionStore } from "./interactions/drizzle-store";
import { InteractionsController } from "./interactions/interactions.controller";
import { InteractionsModule } from "./interactions/interactions.module";
import { VoiceModule } from "./voice/voice.module";

@Module({
  imports: [
    ConfigModule,
    DbModule,
    InteractionsModule,
    VoiceModule.register({ store: DrizzleInteractionStore }),
  ],
  controllers: [HealthController, AgentsController, InteractionsController],
  providers: [{ provide: APP_FILTER, useClass: ProblemJsonFilter }],
})
export class AppModule {}
