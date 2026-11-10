import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";

import { AppModule } from "./app.module";
import { ENV } from "./config/config.module";
import type { Env } from "./config/env";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const env = app.get<Env>(ENV);
  app.enableCors({ origin: env.ALLOWED_ORIGINS, credentials: false });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  await app.listen(env.PORT, "127.0.0.1");
}

void bootstrap();
