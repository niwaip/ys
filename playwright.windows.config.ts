import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "windows.spec.ts",
  use: { ...base.use, baseURL: "http://127.0.0.1:4176" },
  webServer: {
    ...(base.webServer as object),
    command: "npm run dev",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
    env: {
      ...(base.webServer as any).env,
      PORT: "3104",
      VITE_API_PORT: "3104",
      VITE_PORT: "4176",
      DATABASE_URL: "pglite://.data/browser-t03",
    },
  },
});
