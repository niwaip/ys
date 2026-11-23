// Test-only subprocess. It never invokes Trivy, scans, or networks.
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Version: fixture-process-1");
  process.exit(0);
}
const path = require("node:path");
const cache = args.includes("--cache-dir")
  ? args[args.indexOf("--cache-dir") + 1]
  : null;
if (args.includes("--download-db-only")) {
  fs.mkdirSync(path.join(cache, "db"), { recursive: true });
  fs.appendFileSync(path.join(cache, "sequence.log"), "update\n");
  if (fs.existsSync(path.join(cache, "fail-update"))) {
    console.error("fixture database update failed");
    process.exit(2);
  }
  if (fs.existsSync(path.join(cache, "timeout-update"))) {
    setInterval(() => {}, 1000);
    return;
  }
  if (
    fs.existsSync(path.join(cache, "fresh-update")) ||
    !fs.existsSync(path.join(cache, "db/metadata.json"))
  )
    fs.writeFileSync(
      path.join(cache, "db/metadata.json"),
      JSON.stringify({
        Version: 2,
        UpdatedAt: "2026-11-23T00:00:00Z",
        NextUpdate: "2099-01-01T00:00:00Z",
      }),
    );
  fs.writeFileSync(path.join(cache, "db/trivy.db"), "test-only");
  if (fs.existsSync(path.join(cache, "slow-update"))) {
    setTimeout(() => process.exit(0), 1800);
    return;
  }
  process.exit(0);
}
if (cache) fs.appendFileSync(path.join(cache, "sequence.log"), "scan\n");
if (args[0] === "rootfs") {
  const path = require("node:path");
  const root = args.at(-1);
  const status = fs.readFileSync(
    path.join(root, "var/lib/dpkg/status"),
    "utf8",
  );
  const release = fs.readFileSync(path.join(root, "etc/lsb-release"), "utf8");
  if (
    !args.includes("--offline-scan") ||
    !args.includes("--disable-telemetry") ||
    !release.includes("DISTRIB_RELEASE=24.04") ||
    !status.includes("Source: openssl")
  )
    process.exit(3);
  fs.writeFileSync(
    args[args.indexOf("--output") + 1],
    JSON.stringify({
      SchemaVersion: 2,
      Metadata: { OS: { Family: "ubuntu", Name: "24.04" } },
      Results: [
        {
          Target: "ubuntu",
          Class: "os-pkgs",
          Type: "ubuntu",
          Packages: [{ Name: "libssl3", Version: "3.0.1" }],
          Vulnerabilities: Array.from({ length: 120 }, (_, i) => ({
            VulnerabilityID: `CVE-LINUX-${String(i).padStart(3, "0")}`,
            PkgName: "libssl3",
            InstalledVersion: "3.0.1",
            Severity: "HIGH",
            FixedVersion: "3.0.2",
            PrimaryURL: "https://example.test/linux-advisory",
            Title: "固定测试漏洞说明",
            Description: "仅用于验证来源详情的固定摘要。",
          })),
        },
      ],
    }),
  );
  process.exit(0);
}
const input = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
if (input.fixtureMode === "timeout") {
  setInterval(() => {}, 1000);
  return;
}
if (input.fixtureMode === "exit") {
  console.error("fixture database unavailable");
  process.exit(2);
}
if (
  args[0] !== "sbom" ||
  !args.includes("--skip-db-update") ||
  !args.includes("--offline-scan") ||
  process.env.TRIVY_IGNORE_UNFIXED
) {
  console.error("unsafe invocation");
  process.exit(3);
}
const container = input.metadata?.component?.type === "container";
const output = args[args.indexOf("--output") + 1];
if (input.fixtureMode === "history") {
  const version = input.components[0].version;
  const purl = input.components[0].purl;
  const ids =
    version === "1"
      ? ["CVE-HISTORY-A", "CVE-HISTORY-A", "CVE-HISTORY-B"]
      : ["CVE-HISTORY-A", "CVE-HISTORY-C"];
  fs.writeFileSync(
    output,
    JSON.stringify({
      SchemaVersion: 2,
      Results: [
        {
          Target: "fixture-lock",
          Class: "lang-pkgs",
          Type: "npm",
          Packages:
            version === "1"
              ? [
                  {
                    Name: "express",
                    Version: version,
                    Identifier: { PURL: purl },
                  },
                ]
              : [],
          Vulnerabilities: ids.map((id) => ({
            VulnerabilityID: id,
            PkgName: "express",
            InstalledVersion: version,
            PkgIdentifier: { PURL: purl },
            Severity: "HIGH",
          })),
        },
      ],
    }),
  );
  console.error("history fixture only");
  process.exit(0);
}

fs.writeFileSync(
  output,
  JSON.stringify({
    SchemaVersion: 2,
    ArtifactType: "cyclonedx",
    Results: [
      {
        Target: "fixture-target",
        Class: "lang-pkgs",
        Type: container ? "debian" : "npm",
        Packages: [
          {
            Name: container ? "libssl3" : "express",
            Version: container ? "3.0.1" : "4.18.0",
            Identifier: {
              PURL: container
                ? "pkg:deb/debian/libssl3@3.0.1?distro=debian-12"
                : "pkg:npm/express@4.18.0",
            },
          },
        ],
        Vulnerabilities:
          input.fixtureMode === "findings"
            ? [
                {
                  VulnerabilityID: container
                    ? "CVE-2099-CONTAINER"
                    : "CVE-2099-FIXTURE",
                  PkgName: container ? "libssl3" : "express",
                  InstalledVersion: container ? "3.0.1" : "4.18.0",
                  Severity: "HIGH",
                  FixedVersion: container ? "3.0.2" : "4.19.2",
                  PrimaryURL: "https://example.test/fixture",
                  PkgIdentifier: {
                    PURL: container
                      ? "pkg:deb/debian/libssl3@3.0.1?distro=debian-12"
                      : "pkg:npm/express@4.18.0",
                  },
                },
              ]
            : [],
      },
    ],
  }),
);
console.error("fixture evidence stderr");
