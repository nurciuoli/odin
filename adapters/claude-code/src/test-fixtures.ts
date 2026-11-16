// A transcript with streamed duplicates, two models, a synthetic message and a junk line.
const line = (o: unknown) => JSON.stringify(o);
export const user = (timestamp: string) => line({ type: "user", timestamp, message: { role: "user", content: "hi" } });
export const assistant = (id: string, model: string, timestamp: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", timestamp, ...extra, message: { id, model, role: "assistant", usage } });

export const FIXTURE = [
  user("2026-10-17T10:00:00.000Z"),
  // streamed: three lines for one message, the last carries the final output count
  assistant("msg_1", "claude-sonnet-5-5", "2026-10-17T10:00:02.000Z", { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
  assistant("msg_1", "claude-sonnet-5-5", "2026-10-17T10:00:03.000Z", { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
  assistant("msg_1", "claude-sonnet-5-5", "2026-10-17T10:00:04.000Z", { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }),
  "this is not json {",
  "",
  user("2026-10-17T10:00:05.000Z"),
  assistant("msg_2", "claude-haiku-4-5", "2026-10-17T10:00:06.500Z", { input_tokens: 10, output_tokens: 7 }),
  user("2026-10-17T10:00:07.000Z"),
  assistant("msg_3", "claude-sonnet-5-5", "2026-10-17T10:00:10.000Z", { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 1200 }),
  assistant("msg_s", "<synthetic>", "2026-10-17T10:00:11.000Z", { input_tokens: 0, output_tokens: 0 }),
  line({ type: "summary", summary: "x" }),
].join("\n");
