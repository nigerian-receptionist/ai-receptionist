import { Module } from "@nestjs/common";

import { DrizzleInteractionStore } from "./drizzle-store";
import { INTERACTION_STORE } from "./interaction-store";

@Module({
  providers: [{ provide: INTERACTION_STORE, useClass: DrizzleInteractionStore }],
  exports: [INTERACTION_STORE],
})
export class InteractionsModule {}
