import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiCapability, type PiRpcConfig } from "../agent/pi-rpc";
import { AgentExecutionError } from "../agent/errors";
import type { AppConfig } from "../config";
import type { CustomerConversation } from "../../../../packages/contracts/conversations";
export interface CustomerReadExecutor {
  execute(
    input: Pick<
      CustomerConversation,
      "id" | "customerId" | "message" | "facts"
    >,
    emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}
export class PiCustomerReadExecutor implements CustomerReadExecutor {
  constructor(private config: PiRpcConfig & { artifactRoot: string }) {}
  async execute(
    input: Pick<
      CustomerConversation,
      "id" | "customerId" | "message" | "facts"
    >,
    emit: Parameters<CustomerReadExecutor["execute"]>[1],
    signal: AbortSignal,
  ) {
    const root = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const jobDir = resolve(this.config.artifactRoot, input.id);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    const requestFile = join(jobDir, "request.json");
    await writeFile(
      requestFile,
      JSON.stringify({ capability: "customer-read", ...input }),
      { mode: 0o600 },
    );
    await runPiCapability(
      this.config,
      {
        jobDir,
        requestFile,
        extension: join(root, "tools/pi/customer-read-extension.mjs"),
        skill: join(root, "tools/pi/skills/customer-read/SKILL.md"),
        tools: ["ys_customer_assessment_read"],
        requiredTools: ["ys_customer_assessment_read"],
        prompt:
          "/skill:ys-customer-read 读取本次已授权客户评估事实，说明已保存的证据与覆盖缺口。",
      },
      emit,
      signal,
    );
  }
}
export function configuredCustomerExecutor(
  config?: AppConfig["pi"],
): CustomerReadExecutor {
  if (!config?.executable)
    return {
      async execute() {
        throw new AgentExecutionError(
          "unavailable",
          "Pi 未配置；已读取的固定事实保留，未生成模型解释",
        );
      },
    };
  return new PiCustomerReadExecutor({
    ...config,
    executable: config.executable,
    artifactRoot: resolve(config.artifactRoot ?? ".data/agent"),
  });
}
