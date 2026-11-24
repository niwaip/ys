#!/usr/bin/env node
import { readFile } from "node:fs/promises";
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const at = buffer.indexOf("\n");
  if (at < 0) return;
  const command = JSON.parse(buffer.slice(0, at));
  buffer = "";
  const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
  send({ type: "response", id: command.id, success: true });
  const mode = process.env.YS_REPORT_FIXTURE_MODE;
  if (mode === "timeout") return;
  const extension = process.argv[process.argv.indexOf("-e") + 1],
    tools = new Map();
  (await import(extension)).default({
    registerTool: (t) => tools.set(t.name, t),
  });
  try {
    send({
      type: "tool_execution_start",
      toolName: "ys_report_facts",
      toolCallId: "facts",
    });
    const facts = await tools
      .get("ys_report_facts")
      .execute("facts", {}, new AbortController().signal);
    send({
      type: "tool_execution_end",
      toolName: "ys_report_facts",
      toolCallId: "facts",
      isError: false,
    });
    if (mode !== "missing_tool") {
      const input = JSON.parse(facts.content[0].text);
      send({
        type: "tool_execution_start",
        toolName: "ys_report_proposal",
        toolCallId: "proposal",
      });
      await tools.get("ys_report_proposal").execute(
        "proposal",
        {
          narrative: {
            ...input.allowedNarrative,
            blocks: [
              {
                templateId: "summary",
                wording: "standard",
                text: "针对【scope】，请结合保护事实解读。接下来，建议复核来源证据，以便保留复核依据。",
              },
              ...input.allowedNarrative.blocks.slice().reverse(),
            ],
          },
        },
        new AbortController().signal,
      );
      send({
        type: "tool_execution_end",
        toolName: "ys_report_proposal",
        toolCallId: "proposal",
        isError: false,
      });
    }
    send({ type: "agent_settled" });
  } catch (e) {
    send({
      type: "tool_execution_end",
      toolName: "ys_report_proposal",
      toolCallId: "proposal",
      isError: true,
    });
  }
});
