import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "../config";
import { AgentExecutionError } from "../agent/errors";
import { runPiCapability } from "../agent/pi-rpc";
import {
  hostCollectionSchema,
  type HostCollection,
} from "../../../../packages/contracts/collections";
export type CollectionProfile = NonNullable<
  AppConfig["collection"]
>["profiles"][number];
export type CollectionTaskInput = {
  id: string;
  customerId: string;
  assetId: string;
  profileId: string;
  scope: "basic" | "container-inventory";
  message: string;
};
export interface CollectionExecutor {
  execute(
    input: CollectionTaskInput,
    profile: CollectionProfile,
    emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<HostCollection>;
}
export class PiCollectionExecutor implements CollectionExecutor {
  constructor(private readonly config: NonNullable<AppConfig["pi"]>) {}
  async execute(
    input: CollectionTaskInput,
    profile: CollectionProfile,
    emit: Parameters<CollectionExecutor["execute"]>[2],
    signal: AbortSignal,
  ) {
    if (!this.config.executable)
      throw new AgentExecutionError("unavailable", "Pi未配置，未执行采集");
    for (const [path, secret] of [
      [profile.identityFile, true],
      [profile.knownHostsFile, false],
    ] as const) {
      try {
        const file = await stat(path);
        if (!file.isFile() || (secret && (file.mode & 0o077) !== 0))
          throw new Error("mode");
      } catch {
        throw new AgentExecutionError(
          "unavailable",
          "SSH认证或可信主机文件不可用；请由管理员检查受控连接配置",
        );
      }
    }
    const root = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const jobDir = resolve(
      this.config.artifactRoot ?? ".data/agent-collection",
      input.id,
    );
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    const requestFile = join(jobDir, "request.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        capability: "host-collection",
        ...input,
        profile,
        jobDir,
      }),
      { mode: 0o600, flag: "wx" },
    );
    try {
      await runPiCapability(
        { ...this.config, executable: this.config.executable },
        {
          jobDir,
          requestFile,
          extension: join(root, "tools/pi/host-collection-extension.mjs"),
          skill: join(root, "tools/pi/skills/host-collection/SKILL.md"),
          tools: ["ys_host_collect"],
          requiredTools: ["ys_host_collect"],
          prompt: `/skill:ys-host-collection 执行本次已授权固定采集。以下是需求资料：${JSON.stringify({ customerId: input.customerId, assetId: input.assetId, scope: input.scope, message: input.message })}`,
        },
        emit,
        signal,
      );
    } catch (error) {
      const failureFile = join(jobDir, "failure.json");
      const messages = {
        host_key_failed: "SSH主机身份校验失败，未连接未知身份",
        login_failed: "SSH登录被拒绝",
        timed_out: "SSH采集超时，未自动重试",
        connection_failed: "SSH连接或固定脚本执行失败",
        output_limit: "SSH输出超限，未保存截断清单",
        protocol_invalid: "固定采集协议或产物格式不兼容",
      };
      let code: keyof typeof messages | undefined;
      try {
        if (
          (await realpath(failureFile)) !==
            join(await realpath(jobDir), "failure.json") ||
          (await stat(failureFile)).size > 4096
        )
          throw new Error("failure artifact");
        const failure = z
          .object({
            jobId: z.literal(input.id),
            customerId: z.literal(input.customerId),
            assetId: z.literal(input.assetId),
            profileId: z.literal(input.profileId),
            scope: z.literal(input.scope),
            code: z.enum([
              "host_key_failed",
              "login_failed",
              "timed_out",
              "connection_failed",
              "output_limit",
              "protocol_invalid",
            ]),
          })
          .strict()
          .parse(JSON.parse(await readFile(failureFile, "utf8")));
        code = failure.code;
      } catch {}
      if (code)
        throw new AgentExecutionError(
          code === "timed_out" ? "timed_out" : "failed",
          messages[code],
        );
      throw error;
    }
    const file = join(jobDir, "collection.json");
    try {
      if (
        (await realpath(file)) !==
          join(await realpath(jobDir), "collection.json") ||
        (await stat(file)).size > 5000000
      )
        throw new Error("artifact");
      const envelope = z
        .object({
          jobId: z.literal(input.id),
          customerId: z.literal(input.customerId),
          assetId: z.literal(input.assetId),
          profileId: z.literal(input.profileId),
          scope: z.literal(input.scope),
          data: hostCollectionSchema,
        })
        .strict()
        .parse(JSON.parse(await readFile(file, "utf8")));
      if (
        input.scope === "basic" &&
        (envelope.data.sections.containers || envelope.data.sections.images)
      )
        throw new Error("scope");
      return {
        ...envelope.data,
        extensions: {
          ...envelope.data.extensions,
          execution: {
            jobId: input.id,
            profileId: input.profileId,
            scope: input.scope,
          },
        },
      };
    } catch {
      throw new AgentExecutionError(
        "failed",
        "采集产物缺失、超限或目标/范围校验失败，未保存快照",
      );
    }
  }
}
