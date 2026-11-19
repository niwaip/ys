import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "dashboard.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4188" },
  webServer: {
    ...(base.webServer as object),
    command: "node tests/fixtures/trivy/setup.cjs && npm run dev",
    url: "http://127.0.0.1:3118/api/customers",
    reuseExistingServer: false,
    env: {
      ...(base.webServer as any).env,
      PORT: "3118",
      VITE_API_PORT: "3118",
      VITE_PORT: "4188",
      DATABASE_URL: "pglite://.data/browser-t12",
    },
  },
});
