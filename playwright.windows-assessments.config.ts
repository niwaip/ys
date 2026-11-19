import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "windows-assessments.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4187" },
  webServer: {
    ...(base.webServer as object),
    command: "npm run dev",
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
    env: {
      ...(base.webServer as any).env,
      PORT: "3117",
      VITE_API_PORT: "3117",
      VITE_PORT: "4187",
      DATABASE_URL: "pglite://.data/browser-t07",
    },
  },
});
