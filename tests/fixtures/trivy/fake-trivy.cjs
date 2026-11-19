// Test-only subprocess. It never invokes Trivy, scans, or networks.
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Version: fixture-process-1");
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
