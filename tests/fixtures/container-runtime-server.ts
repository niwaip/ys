import { createApp } from "../../apps/api/src/app";
import { resolve } from "node:path";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import request from "supertest";
const path = resolve(".data/browser-container-runtime");
await rm(path, { recursive: true, force: true });
const config = {
  databaseUrl: `pglite://${path}`,
  customers: [
    { id: "acme", name: "容器测试客户" },
    { id: "river", name: "隔离客户" },
  ],
  operators: [
    {
      token: "browser-test-secret-token",
      name: "测试操作员",
      customerIds: ["acme", "river"],
    },
  ],
  trivy: {
    executable: resolve(".data/container-trivy-browser-fixture/trivy.cjs"),
    cacheDir: resolve(".data/container-trivy-browser-fixture"),
  },
};
const fixture = resolve(".data/container-runtime-ssh.cjs");
await writeFile(
  fixture,
  (
    await readFile(resolve("tests/fixtures/container-runtime-ssh.cjs"), "utf8")
  ).replace("#!/usr/bin/env node", `#!${process.execPath}`),
  { mode: 0o700 },
);
let app = await createApp(config);
const asset = (
  await request(app.getHttpServer())
    .post("/api/customers/acme/assets")
    .auth("browser-test-secret-token", { type: "bearer" })
    .send({ name: "Docker测试主机", kind: "host" })
).body;
await app.close();
app = await createApp({
  ...config,
  collection: {
    profiles: [
      {
        id: "docker-fixture",
        label: "Docker测试连接",
        assetId: asset.id,
        customerId: "acme",
        host: "fixture",
        username: "reader",
        knownHostsFile: "/fixture/hosts",
        identityFile: "/fixture/key",
        allowDocker: true,
        sshExecutable: fixture,
      },
    ],
  },
});
await app.listen(3219, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
