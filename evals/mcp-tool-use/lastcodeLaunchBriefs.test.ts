import { assert, it } from "@effect/vitest";
import { gradeSample, type SampleRun } from "./run.ts";

const callback = "Send the result using t3_thread_send to 3333 in queue mode.";
const expectsCallback = { threadBriefs: { must: ["t3_thread_send", "3333", "queue"] } };
const remote = "build-host";
const launch = (message: string) => ({
  tool: "t3_thread_launch",
  input: { environmentId: remote, message },
  output: '{"threadId":"t-1","status":"idle"}',
});
const send = (threadId: string, message: string) => ({
  tool: "t3_thread_send",
  input: { environmentId: remote, threadId, message },
});
const batch = (prompt: string) => ({
  tool: "create_threads",
  input: { threads: [{ prompt }] },
});
const run = (...calls: Array<Omit<SampleRun["calls"][number], "step">>): SampleRun => ({
  calls: calls.map((call, step) => ({ ...call, step })),
  text: "",
  stopReason: "end_turn",
});

const passes = (expect: Parameters<typeof gradeSample>[0], sample: SampleRun) =>
  gradeSample(expect, sample).every((check) => check.pass);

it("requires the callback in each single and batched launch brief", () => {
  assert.isTrue(passes(expectsCallback, run(launch(callback), batch(callback))));
  assert.isFalse(passes(expectsCallback, run(launch(callback), batch("Run it."))));
  assert.isFalse(passes(expectsCallback, run({ ...launch(callback), failed: true })));
  assert.isFalse(passes({ threadBriefs: { mustNot: ["3333"] } }, run(batch(callback))));
});

it("uses the first successful send to a launch that started idle", () => {
  const idle = launch("");
  const unrelated = send("t-2", callback);
  const failed = { ...send("t-1", "Run it."), failed: true };
  const elsewhere = send("t-1", callback);
  elsewhere.input.environmentId = "other-host";
  const first = send("t-1", callback);
  assert.isTrue(
    passes({ ...expectsCallback, newThreads: ["~3333"] }, run(idle, unrelated, failed, first)),
  );
  assert.isFalse(passes(expectsCallback, run(idle, unrelated, elsewhere)));
  assert.isFalse(passes(expectsCallback, run(idle, send("t-1", "Run it."), first)));
  assert.isFalse(passes(expectsCallback, run(launch("Run it."), first)));
});
