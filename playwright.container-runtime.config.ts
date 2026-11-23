import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "container-runtime.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4299",
    channel: process.env.PLAYWRIGHT_CHANNEL,
    headless: true,
  },
  webServer: [
    {
      command:
        "node tests/fixtures/trivy/setup.cjs && npx tsx tests/fixtures/container-runtime-server.ts",
      url: "http://127.0.0.1:3219/api/customers",
      env: { YS_TRIVY_FIXTURE_DIR: ".data/container-trivy-browser-fixture" },
      reuseExistingServer: false,
    },
    {
      command: "npx vite --host 127.0.0.1",
      url: "http://127.0.0.1:4299",
      env: { VITE_API_PORT: "3219", VITE_PORT: "4299" },
      reuseExistingServer: false,
    },
  ],
});
