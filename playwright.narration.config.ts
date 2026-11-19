import base from "./playwright.config";
import { resolve } from "node:path";
export default {
  ...base,
  testMatch: "report-narration-success.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4274" },
  webServer: {
    ...(base.webServer as object),
    url: "http://127.0.0.1:4274",
    env: {
      ...(base.webServer as { env: Record<string, string> }).env,
      PORT: "3124",
      VITE_API_PORT: "3124",
      VITE_PORT: "4274",
      DATABASE_URL: "pglite://.data/browser-narration",
      YS_PI_EXECUTABLE: resolve("tests/fixtures/report-pi.mjs"),
      YS_AGENT_ARTIFACT_ROOT: ".data/browser-narration-artifacts",
    },
  },
};
