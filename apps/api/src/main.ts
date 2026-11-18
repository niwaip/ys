import "dotenv/config";
import { createApp } from "./app";
import { loadConfig } from "./config";
const app = await createApp(loadConfig());
app.enableShutdownHooks();
await app.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
);
console.log("YS API 已启动");
