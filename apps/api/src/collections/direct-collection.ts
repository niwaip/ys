import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentExecutionError } from "../agent/errors";
import { hostCollectionSchema } from "../../../../packages/contracts/collections";
import type { CollectionExecutor } from "./pi-collection";
export class DirectCollectionExecutor implements CollectionExecutor {
  async execute(
    input: Parameters<CollectionExecutor["execute"]>[0],
    profile: Parameters<CollectionExecutor["execute"]>[1],
    emit: Parameters<CollectionExecutor["execute"]>[2],
    signal: AbortSignal,
  ) {
    await emit(
      "tool_started",
      profile.transport === "local"
        ? input.scope === "basic"
          ? "开始 YS 部署主机基础采集"
          : "开始 YS 部署主机容器目录发现"
        : "正在连接主机执行固定采集",
    );
    try {
      const module = await import(
        pathToFileURL(
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../../../tools/collection/collect.mjs",
          ),
        ).href
      );
      const data = hostCollectionSchema.parse(
        await module.collect(profile, input.scope, signal),
      );
      await emit("tool_completed", "采集完成，正在保存资料");
      return {
        ...data,
        extensions: {
          ...data.extensions,
          execution: {
            jobId: input.id,
            profileId: input.profileId,
            scope: input.scope,
            method: "ssh",
            transport: profile.transport ?? "ssh",
          },
        },
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const messages: Record<string, string> = {
        host_key_failed: "主机身份校验失败，请核对主机指纹",
        login_failed: "SSH登录被拒绝，请检查账号和凭证",
        timed_out: "主机采集超时，未自动重试",
        connection_failed: "无法连接主机或固定采集程序失败",
        output_limit: "采集输出超限，未保存截断清单",
      };
      throw new AgentExecutionError(
        code === "timed_out" ? "timed_out" : "failed",
        messages[code ?? ""] ?? "固定采集输出无效，未保存成功快照",
      );
    }
  }
}
