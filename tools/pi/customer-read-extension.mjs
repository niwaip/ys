import { readFile } from "node:fs/promises";
export default function (pi) {
  pi.registerTool({
    name: "ys_customer_assessment_read",
    label: "已授权客户评估只读查询",
    description:
      "读取后端已授权并固定的单客户软件评估事实；不接受对象或客户参数。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const request = JSON.parse(
        await readFile(process.env.YS_AGENT_REQUEST_FILE, "utf8"),
      );
      if (request.capability !== "customer-read") throw new Error("能力不符");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              customerId: request.customerId,
              question: request.message,
              facts: request.facts,
            }),
          },
        ],
        details: { factHash: request.facts.hash },
      };
    },
  });
}
