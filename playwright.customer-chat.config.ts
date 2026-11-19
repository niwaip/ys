import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "customer-chat.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4190",
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4190",
    reuseExistingServer: false,
    env: {
      PORT: "3120",
      VITE_API_PORT: "3120",
      VITE_PORT: "4190",
      DATABASE_URL: "pglite://.data/browser-chat",
      YS_PI_EXECUTABLE: "",
      YS_CVE_SCRIPT: "",
      YS_CUSTOMERS:
        '[{"id":"acme","name":"星河科技"},{"id":"river","name":"远山集团"}]',
      YS_OPERATORS:
        '[{"token":"browser-test-secret-token","name":"测试操作员","customerIds":["acme","river"]}]',
    },
  },
});
