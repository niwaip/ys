#!/usr/bin/env node
// Fixed subprocess fixture; never connects to SSH or Docker.
let script = "";
process.stdin.on("data", (c) => (script += c));
process.stdin.on("end", () => {
  const a = "sha256:" + "a".repeat(64),
    b = "sha256:" + "b".repeat(64),
    f = "sha256:" + "f".repeat(64);
  if (script.includes("trivy image --image-src docker")) {
    const id = script.match(/set -- '(sha256:[a-f0-9]{64})'/)?.[1];
    if (id === f) {
      process.exit(127);
      return;
    }
    if (
      !id ||
      !script.includes("image inspect") ||
      script.includes("docker pull") ||
      /^\s*sudo\s/m.test(script)
    )
      process.exit(3);
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      fixtureMode: "findings",
      metadata: {
        component: {
          type: "container",
          name: id === a ? "fixture/app" : "fixture/worker",
        },
      },
      components: [
        {
          type: "library",
          name: "libssl3",
          version: "3.0.1",
          purl: "pkg:deb/debian/libssl3@3.0.1?distro=debian-12",
        },
      ],
    };
    const fields = {
      YS_IMAGE: JSON.stringify({
        imageId: id,
        architecture: "amd64",
        os: "linux",
        repoTags: [id === a ? "fixture/app:v1" : "fixture/worker:v1"],
        repoDigests: [],
      }),
      YS_HOST: "fixture-host",
      YS_MACHINE: "fixture-machine",
      YS_SERIAL: "",
      YS_TIME: "2026-11-23T00:00:00Z",
      YS_TOOL: "fixture-trivy-generator",
      YS_SBOM: JSON.stringify(sbom),
    };
    for (const [k, v] of Object.entries(fields))
      console.log(k + "|" + Buffer.from(v).toString("base64"));
  } else {
    const fields = {
      hostname: "fixture-host",
      machineId: "fixture-machine",
      serial: "",
      images: [
        { ID: a, Repository: "fixture/app", Tag: "v1", Digest: "<none>" },
        { ID: a, Repository: "fixture/app", Tag: "stable", Digest: "<none>" },
        { ID: b, Repository: "fixture/worker", Tag: "v1", Digest: "<none>" },
        {
          ID: f,
          Repository: "fixture/unavailable",
          Tag: "v1",
          Digest: "<none>",
        },
      ]
        .map((v) => JSON.stringify(v))
        .join("\n"),
      containers: [
        {
          containerId: "c".repeat(64),
          imageId: a,
          name: "app-1",
          state: "running",
        },
        {
          containerId: "d".repeat(64),
          imageId: a,
          name: "app-2",
          state: "running",
        },
        {
          containerId: "e".repeat(64),
          imageId: b,
          name: "worker",
          state: "exited",
        },
      ]
        .map((v) => JSON.stringify(v))
        .join("\n"),
      dockerDaemon: JSON.stringify({ Version: "fixture-docker" }),
    };
    for (const [k, v] of Object.entries(fields))
      console.log(k + "|0|" + Buffer.from(v).toString("base64"));
  }
});
