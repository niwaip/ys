import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
export default function (pi) {
  async function invoke(action, narrative, signal) {
    const r = JSON.parse(
      await readFile(process.env.YS_AGENT_REQUEST_FILE, "utf8"),
    );
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [r.scriptPath, action], {
        shell: false,
        signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        size = 0;
      child.stdout.on("data", (c) => {
        size += c.length;
        if (size > 500000) child.kill("SIGKILL");
        else output += c;
      });
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 && size <= 500000
          ? resolve({
              content: [{ type: "text", text: output }],
              details: { contract: "report-proposal-v1" },
            })
          : reject(Error("固定报告脚本失败")),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(narrative === undefined ? "" : JSON.stringify(narrative));
    });
  }
  pi.registerTool({
    name: "ys_report_facts",
    label: "读取绑定报告事实",
    description: "读取后端绑定的单份报告事实摘要和保护段落目录。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: (_id, _params, signal) => invoke("facts", undefined, signal),
  });
  pi.registerTool({
    name: "ys_report_proposal",
    label: "保存受控报告段落提案",
    description:
      "使用绑定事实引用和language目录句法提交text说明/建议文字、段落排列及密度，后端再校验。",
    parameters: {
      type: "object",
      properties: {
        narrative: {
          type: "object",
          properties: {
            schemaVersion: { const: "controlled-paragraphs-v1" },
            density: { enum: ["standard", "compact"] },
            blocks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  templateId: {
                    enum: [
                      "scope",
                      "assessment",
                      "lifecycle",
                      "coverage",
                      "evidence",
                      "summary",
                      "recommendations",
                    ],
                  },
                  factRef: { type: "string" },
                  text: { type: "string", maxLength: 4000 },
                  wording: { enum: ["standard", "concise"] },
                },
                required: ["templateId", "wording"],
                additionalProperties: false,
              },
            },
          },
          required: ["schemaVersion", "density", "blocks"],
          additionalProperties: false,
        },
      },
      required: ["narrative"],
      additionalProperties: false,
    },
    execute: (_id, params, signal) =>
      invoke("proposal", params.narrative, signal),
  });
}
