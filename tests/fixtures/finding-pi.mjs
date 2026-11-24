// Local RPC fixture: calls the real fixed extension, never a model provider.
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const at = buffer.indexOf("\n");
  if (at < 0) return;
  const command = JSON.parse(buffer.slice(0, at));
  buffer = "";
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  send({ type: "response", id: command.id, success: true });
  const tools = new Map();
  (await import(process.argv[process.argv.indexOf("-e") + 1])).default({
    registerTool: (t) => tools.set(t.name, t),
  });
  const invoke = async (name, params) => {
    send({ type: "tool_execution_start", toolName: name, toolCallId: name });
    const result = await tools.get(name).execute(name, params);
    send({
      type: "tool_execution_end",
      toolName: name,
      toolCallId: name,
      isError: false,
    });
    return result;
  };
  try {
    const facts = JSON.parse(
      (await invoke("ys_finding_facts", {})).content[0].text,
    );
    const section = {
      text: "固定样例：可能影响组件使用方，需核实运行状态并测试升级。",
      sourceIds: ["finding"],
    };
    if (
      ["invalid_then_correct", "invalid_exhausted"].includes(
        process.env.YS_FINDING_FIXTURE_MODE,
      )
    ) {
      const attempts =
        process.env.YS_FINDING_FIXTURE_MODE === "invalid_exhausted" ? 3 : 1;
      for (let i = 0; i < attempts; i++) {
        const toolCallId = `invalid-${i}`;
        send({
          type: "tool_execution_start",
          toolName: "ys_finding_analysis",
          toolCallId,
        });
        send({
          type: "tool_execution_end",
          toolName: "ys_finding_analysis",
          toolCallId,
          isError: true,
          result: {
            content: [
              {
                type: "text",
                text: 'Invalid arguments for tool "ys_finding_analysis": malformed JSON\nReceived arguments: PRIVATE-FACT-MUST-NOT-LEAK',
              },
            ],
          },
        });
      }
    }
    if (process.env.YS_FINDING_FIXTURE_MODE !== "missing_tool")
      await invoke("ys_finding_analysis", {
        narrative: {
          explanation: section,
          impact: section,
          checks: [section],
          nextSteps: [section],
        },
      });
    send({ type: "agent_settled" });
  } catch {
    send({
      type: "tool_execution_end",
      toolName: "ys_finding_analysis",
      toolCallId: "ys_finding_analysis",
      isError: true,
    });
  }
});
