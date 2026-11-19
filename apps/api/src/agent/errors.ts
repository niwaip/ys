export class AgentExecutionError extends Error {
  constructor(
    public status: "failed" | "timed_out" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
