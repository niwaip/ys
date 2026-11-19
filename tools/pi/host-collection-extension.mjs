import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collect } from "../collection/collect.mjs";
export default function (pi) {
  let completed;
  pi.registerTool({
    name: "ys_host_collect",
    label: "受控主机资料采集",
    description:
      "执行后端已绑定客户、资产、连接和范围的固定只读采集。参数为空；返回覆盖与产物回执。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, args, _signal) {
      if (args && Object.keys(args).length) throw new Error("不接受工具参数");
      if (completed) return completed;
      const request = JSON.parse(
        await readFile(process.env.YS_AGENT_REQUEST_FILE, "utf8"),
      );
      if (request.capability !== "host-collection")
        throw new Error("能力不匹配");
      let data;
      try {
        data = await collect(request.profile, request.scope, _signal);
      } catch (error) {
        const allowed = [
          "host_key_failed",
          "login_failed",
          "timed_out",
          "connection_failed",
          "output_limit",
        ];
        const code = allowed.includes(error?.code)
          ? error.code
          : "protocol_invalid";
        await writeFile(
          join(request.jobDir, "failure.json"),
          JSON.stringify({
            jobId: request.id,
            customerId: request.customerId,
            assetId: request.assetId,
            profileId: request.profile.id,
            scope: request.scope,
            code,
          }),
          { mode: 0o600, flag: "wx" },
        );
        throw new Error("固定采集失败，已保存受控错误代码");
      }
      await writeFile(
        join(request.jobDir, "collection.json"),
        JSON.stringify({
          jobId: request.id,
          customerId: request.customerId,
          assetId: request.assetId,
          profileId: request.profile.id,
          scope: request.scope,
          data,
        }),
        { mode: 0o600, flag: "wx" },
      );
      completed = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              jobId: request.id,
              scope: request.scope,
              sections: Object.fromEntries(
                Object.entries(data.sections).map(([key, value]) => [
                  key,
                  {
                    status: value.status,
                    count: Array.isArray(value.data) ? value.data.length : null,
                  },
                ]),
              ),
            }),
          },
        ],
      };
      return completed;
    },
  });
}
