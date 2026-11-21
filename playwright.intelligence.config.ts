import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "intelligence.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4189",
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4189",
    reuseExistingServer: false,
    env: {
      PORT: "3119",
      VITE_API_PORT: "3119",
      VITE_PORT: "4189",
      DATABASE_URL: "pglite://.data/browser-intelligence",
      YS_PI_EXECUTABLE: "",
      YS_CVE_SCRIPT: "",
      YS_CUSTOMERS:
        '[{"id":"acme","name":"星河科技"},{"id":"river","name":"远山集团"}]',
      YS_OPERATORS:
        '[{"token":"browser-test-secret-token","name":"测试操作员","customerIds":["acme","river"]}]',
    },
  },
});
