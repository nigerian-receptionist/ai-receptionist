import { DynamicModule, Module, Type } from "@nestjs/common";

import type { InteractionStore } from "../interactions/interaction-store";
import { INTERACTION_STORE } from "../interactions/interaction-store";
import { VoiceGateway } from "./voice.gateway";

/**
 * Realtime voice loop: WebSocket gateway plus the session state machine.
 * Vendor adapters are constructed per session inside the gateway from ENV.
 * The persistence contract comes from the caller via `register({ store })` so
 * the data layer can swap the implementation without touching this module.
 */
@Module({})
export class VoiceModule {
  static register(opts: { store: Type<InteractionStore> }): DynamicModule {
    return {
      module: VoiceModule,
      providers: [VoiceGateway, { provide: INTERACTION_STORE, useClass: opts.store }],
      exports: [VoiceGateway],
    };
  }
}
