import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostCollectionSchema } from "../../packages/contracts/collections";

test("固定基础采集保留运行环境、端口与失败状态，未取得不解释为未加载", async () => {
  // Exercise the collector's subprocess/protocol boundary, without connecting to any host.
  const { collect } = await import(
    new URL("../../tools/collection/collect.mjs", import.meta.url).href
  );
  const dir = await mkdtemp(join(tmpdir(), "ys-runtime-"));
  try {
    for (const failed of [false, true]) {
      const executable = join(dir, `ssh-${failed}.mjs`);
      await writeFile(
        executable,
        `#!${process.execPath}
let script='';process.stdin.on('data', c=>script+=c);process.stdin.on('end',()=>{
 if (script.includes('emit dockerDaemon') || !script.includes('emit virtualization systemd-detect-virt --vm') || !script.includes('emit listeningPorts ss -H -lntu') || script.includes('modprobe')) process.exit(2);
 const values={hostname:[0,'host'],os:[0,'ID=ubuntu\\nVERSION_ID=24.04'],kernel:[0,'6.8.0-generic'],architecture:[0,'x86_64'],packages:[0,'dpkg\\tlibssl3\\t3.0.1\\tamd64\\tinstalled'],virtualization:[${failed ? 127 : 0},'${failed ? "missing" : "kvm"}'],xenNetback:[${failed ? 1 : 0},'false'],listeningPorts:[${failed ? 127 : 0},'tcp LISTEN 0 128 127.0.0.1:3001 0.0.0.0:*']};
 for(const [k,[code,text]] of Object.entries(values))process.stdout.write(k+'|'+code+'|'+Buffer.from(text).toString('base64')+'\\n');
});`,
        { mode: 0o700 },
      );
      const result = hostCollectionSchema.parse(
        await collect(
          {
            allowDocker: true,
            sshExecutable: executable,
            host: "fixture",
            username: "reader",
            identityFile: "fixture",
            knownHostsFile: "fixture",
          },
          "basic",
        ),
      );
      const os = result.sections.os!.data as {
        kernel: string;
        runtime: {
          virtualization: { status: string; data: unknown };
          xenNetback: { status: string; data: unknown };
          listeningPorts: { status: string; data: unknown };
        };
      };
      expect(os.kernel).toBe("6.8.0-generic");
      expect(os.runtime.virtualization).toMatchObject(
        failed
          ? { status: "unsupported", data: null }
          : { status: "acquired", data: "kvm" },
      );
      expect(os.runtime.xenNetback).toMatchObject(
        failed
          ? { status: "failed", data: null }
          : { status: "acquired", data: false },
      );
      expect(os.runtime.listeningPorts).toMatchObject(
        failed
          ? { status: "unsupported", data: null }
          : {
              status: "acquired",
              data: expect.stringContaining("127.0.0.1:3001"),
            },
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
