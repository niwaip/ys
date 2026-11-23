import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "multi-device-netbox.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4329",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    headless: true,
  },
  webServer: [
    {
      command: "npx tsx tests/fixtures/multi-device-server.ts",
      url: "http://127.0.0.1:3229/api/customers",
      reuseExistingServer: false,
    },
    {
      command: "npx vite --host 127.0.0.1",
      url: "http://127.0.0.1:4329",
      env: { VITE_API_PORT: "3229", VITE_PORT: "4329" },
      reuseExistingServer: false,
    },
  ],
});
