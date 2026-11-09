"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const platform_ws_1 = require("@nestjs/platform-ws");
const app_module_1 = require("./app.module");
const config_module_1 = require("./config/config.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    const env = app.get(config_module_1.ENV);
    app.enableCors({ origin: env.ALLOWED_ORIGINS, credentials: false });
    app.useWebSocketAdapter(new platform_ws_1.WsAdapter(app));
    app.enableShutdownHooks();
    await app.listen(env.PORT, "127.0.0.1");
}
void bootstrap();
//# sourceMappingURL=main.js.map