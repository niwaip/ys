import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "containers.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4286" },
  webServer: {
    ...(base.webServer as object),
    command: "node tests/fixtures/trivy/setup.cjs && npm run dev",
    url: "http://127.0.0.1:3206/api/customers",
    env: {
      ...(base.webServer as any).env,
      PORT: "3206",
      VITE_API_PORT: "3206",
      VITE_PORT: "4286",
      DATABASE_URL: "pglite://.data/browser-t06",
    },
  },
});
