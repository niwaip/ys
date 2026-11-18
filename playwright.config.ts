import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  workers: 1,
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    env: {
      PORT: "3101",
      VITE_API_PORT: "3101",
      VITE_PORT: "4173",
      DATABASE_URL: "pglite://.data/browser-test",
      YS_CUSTOMERS:
        '[{"id":"acme","name":"星河科技"},{"id":"river","name":"远山集团"}]',
      YS_OPERATORS:
        '[{"token":"browser-test-secret-token","name":"测试操作员","customerIds":["acme","river"]}]',
    },
  },
});
