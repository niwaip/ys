import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "assessments.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4285" },
  webServer: {
    ...(base.webServer as object),
    command: "node tests/fixtures/trivy/setup.cjs && npm run dev",
    url: "http://127.0.0.1:3205/api/customers",
    reuseExistingServer: false,
    env: {
      ...(base.webServer as any).env,
      PORT: "3205",
      VITE_API_PORT: "3205",
      VITE_PORT: "4285",
      DATABASE_URL: "pglite://.data/browser-t05",
      YS_TRIVY_EXECUTABLE: resolve(".data/trivy-browser-fixture/trivy.cjs"),
      YS_TRIVY_CACHE_DIR: resolve(".data/trivy-browser-fixture"),
    },
  },
});
