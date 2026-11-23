// Provision isolated fake executable/database for browser tests only.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(
  process.env.YS_TRIVY_FIXTURE_DIR || ".data/trivy-browser-fixture",
);
fs.mkdirSync(path.join(root, "db"), { recursive: true });
fs.writeFileSync(
  path.join(root, "db", "metadata.json"),
  JSON.stringify({
    Version: 2,
    UpdatedAt: "2020-01-01T00:00:00Z",
    NextUpdate: "2020-01-02T00:00:00Z",
  }),
);
fs.writeFileSync(
  path.join(root, "db", "trivy.db"),
  "test-only-not-a-real-database",
);
fs.writeFileSync(
  path.join(root, "trivy.cjs"),
  `#!${process.execPath}\n` +
    fs.readFileSync(path.join(__dirname, "fake-trivy.cjs"), "utf8"),
);
fs.chmodSync(path.join(root, "trivy.cjs"), 0o700);
