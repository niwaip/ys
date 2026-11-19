import { readFile, writeFile } from "node:fs/promises";
const request = JSON.parse(
  await readFile(process.env.YS_AGENT_REQUEST_FILE, "utf8"),
);
if (process.argv[2] === "facts") {
  await writeFile(
    request.readReceipt,
    JSON.stringify({ factHash: request.input.factHash }),
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(request.input));
} else if (process.argv[2] === "proposal") {
  const receipt = JSON.parse(await readFile(request.readReceipt, "utf8"));
  if (receipt.factHash !== request.input.factHash)
    throw Error("facts receipt mismatch");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 200000) throw Error("proposal too large");
  }
  const narrative = JSON.parse(text);
  const proposal = {
    schemaVersion: "report-proposal-v1",
    baseRevisionId: request.input.baseRevisionId,
    factHash: request.input.factHash,
    narrative,
  };
  await writeFile(request.outputFile, JSON.stringify(proposal), {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      status: "proposal_saved",
      baseRevisionId: proposal.baseRevisionId,
      factHash: proposal.factHash,
    }),
  );
} else throw Error("unsupported report action");
