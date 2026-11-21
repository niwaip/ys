import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "software-history.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4291" },
  webServer: {
    ...(base.webServer as object),
    command: "node tests/fixtures/trivy/setup.cjs && npm run dev",
    url: "http://127.0.0.1:3211/api/customers",
    env: {
      ...(base.webServer as any).env,
      PORT: "3211",
      VITE_API_PORT: "3211",
      VITE_PORT: "4291",
      DATABASE_URL: "pglite://.data/browser-t11",
    },
  },
});
