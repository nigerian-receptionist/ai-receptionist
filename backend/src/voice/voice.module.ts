import { Module } from "@nestjs/common";

import { VoiceGateway } from "./voice.gateway";

/**
 * Realtime voice loop: WebSocket gateway plus the session state machine.
 * Vendor adapters are constructed per session inside the gateway from ENV.
 * The INTERACTION_STORE binding is provided by the data layer (or the
 * in-memory stand-in wired in app.module.ts until the merge).
 */
@Module({ providers: [VoiceGateway], exports: [VoiceGateway] })
export class VoiceModule {}
