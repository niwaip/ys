import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ProcessTrivyExecutor } from "../../apps/api/src/assessments/trivy";
let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "ys-trivy-contract-"));
  await mkdir(join(directory, "db"));
  await writeFile(
    join(directory, "db", "metadata.json"),
    JSON.stringify({
      Version: 2,
      UpdatedAt: "2026-11-01T00:00:00Z",
      NextUpdate: "2026-12-01T00:00:00Z",
    }),
  );
  await writeFile(join(directory, "db", "trivy.db"), "test-only");
  const executable = join(directory, "fake-trivy");
  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      (await readFile(resolve("tests/fixtures/trivy/fake-trivy.cjs"), "utf8")),
  );
  await chmod(executable, 0o700);
  return executable;
}
function input(mode = "ok") {
  const content = JSON.stringify({ fixtureMode: mode });
  return {
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}
test("可配置进程契约使用固定argv与隔离环境并保存版本、库时间、原始报告和退出证据", async () => {
  const executable = await setup();
  process.env.TRIVY_IGNORE_UNFIXED = "true";
  try {
    const result = await new ProcessTrivyExecutor({
      executable,
      cacheDir: directory,
      timeoutMs: 2000,
    }).execute(input(), new AbortController().signal);
    expect(result).toMatchObject({
      status: "succeeded",
      toolVersion: "Version: fixture-process-1",
      exitCode: 0,
      stderr: "fixture evidence stderr\n",
      databaseBefore: { Version: 2 },
      databaseAfter: { NextUpdate: "2026-12-01T00:00:00Z" },
    });
    expect(JSON.parse(result.rawReport!).Results[0].Vulnerabilities).toEqual(
      [],
    );
    expect(result.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.argv).toContain("--skip-java-db-update");
  } finally {
    delete process.env.TRIVY_IGNORE_UNFIXED;
  }
});
test("真实子进程超时、非零退出、缺失工具与缺失数据库明确终止而非零发现", async () => {
  const executable = await setup();
  const timeout = await new ProcessTrivyExecutor({
    executable,
    cacheDir: directory,
    timeoutMs: 100,
  }).execute(input("timeout"), new AbortController().signal);
  expect(timeout.status).toBe("timed_out");
  expect(timeout.error).toContain("超时");
  const failed = await new ProcessTrivyExecutor({
    executable,
    cacheDir: directory,
    timeoutMs: 2000,
  }).execute(input("exit"), new AbortController().signal);
  expect(failed.status).toBe("failed");
  expect(failed.exitCode).toBe(2);
  expect(failed.stderr).toContain("fixture database unavailable");
  const missing = await new ProcessTrivyExecutor({
    executable: join(directory, "missing"),
    cacheDir: directory,
  }).execute(input(), new AbortController().signal);
  expect(missing.status).toBe("unavailable");
  await rm(join(directory, "db", "metadata.json"));
  const db = await new ProcessTrivyExecutor({
    executable,
    cacheDir: directory,
  }).execute(input(), new AbortController().signal);
  expect(db.status).toBe("unavailable");
  expect(db.error).toContain("数据库");
});

test('Linux进程只构造两份固定元数据文件，不接受任意目标路径',async()=>{
 const executable=await setup();
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);if(a[0]==='--version'){console.log('Version: fixture-linux');process.exit(0)};const root=a.at(-1);if(a[0]!=='rootfs'||a[a.indexOf('--pkg-types')+1]!=='os'||!fs.readFileSync(path.join(root,'var/lib/dpkg/status'),'utf8').includes('Package: fixture')||fs.readdirSync(root).sort().join(',')!=='etc,var')process.exit(3);fs.writeFileSync(a[a.indexOf('--output')+1],JSON.stringify({SchemaVersion:2,Metadata:{OS:{Family:'debian',Name:'12'}},Results:[]}));`);
 const content=JSON.stringify({format:'dpkg-status/1',osRelease:'ID=debian\nVERSION_ID="12"',dpkgStatus:'Package: fixture\nStatus: install ok installed\nVersion: 1\nArchitecture: amd64\n'});
 const result=await new ProcessTrivyExecutor({executable,cacheDir:directory}).execute({content,contentHash:createHash('sha256').update(content).digest('hex'),kind:'linux'},new AbortController().signal);
 expect(result.status).toBe('succeeded');expect(result.argv).toContain('rootfs');expect(result.argv).not.toContain('/');
});
