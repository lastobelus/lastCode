// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { gradeSample, McpToolUseCase, type SampleRun } from "./run.ts";

const callback = "Send the result using t3_thread_send to 3333 in queue mode.";
const expectsCallback = { threadBriefs: { must: ["t3_thread_send", "3333", "queue"] } };
const remote = "build-host";
const local = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const launch = (
  message: string,
  target: { environmentId?: string } = { environmentId: remote },
) => ({
  tool: "t3_thread_launch",
  input: { ...target, message },
  output: '{"threadId":"t-1","runId":null,"status":null}',
});
const send = (
  threadId: string,
  message: string,
  target: { environmentId?: string } = { environmentId: remote },
) => ({
  tool: "t3_thread_send",
  input: { ...target, threadId, message },
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
  const elsewhere = send("t-1", callback, { environmentId: "other-host" });
  const first = send("t-1", callback);
  assert.isTrue(
    passes({ ...expectsCallback, newThreads: ["~3333"] }, run(idle, unrelated, failed, first)),
  );
  assert.isFalse(passes(expectsCallback, run(idle, unrelated, elsewhere)));
  assert.isFalse(passes(expectsCallback, run(idle, send("t-1", "Run it."), first)));
  assert.isFalse(passes(expectsCallback, run(launch("Run it."), first)));
});

it("resolves an omitted environment to the local environment for both calls", () => {
  const localLaunch = launch("", {});
  const localSend = send("t-1", callback, {});
  const remoteLaunch = launch("");
  const remoteSend = send("t-1", callback);
  assert.isFalse(passes(expectsCallback, run(remoteLaunch, localSend)));
  assert.isFalse(passes(expectsCallback, run(localLaunch, remoteSend)));
  assert.isTrue(passes(expectsCallback, run(localLaunch, localSend)));
  assert.isTrue(
    passes(expectsCallback, run(localLaunch, send("t-1", callback, { environmentId: local }))),
  );
  assert.isTrue(passes(expectsCallback, run(launch("", { environmentId: local }), localSend)));
});

it("requires a successful lower-mode child launch with a handoff and without a callback", () => {
  const fixtures = NodeFS.readFileSync(
    new URL("./cases/launch-callbacks.ndjson", import.meta.url),
    "utf8",
  );
  const fixture = fixtures
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(McpToolUseCase)(JSON.parse(line)))
    .find((entry) => entry.id === "lc-lower-mode-return-unavailable")!;
  const worker = {
    ...launch("Report the benchmark result in your own thread."),
    input: {
      environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      runtimeMode: "approval-required",
      message: "Report the benchmark result in your own thread.",
    },
    failed: false,
  };
  const finalText =
    "The worker has fewer permissions. Read its result with t3_thread_read at t3-thread://v2/fixture/thread.";
  const grade = (call: Omit<SampleRun["calls"][number], "step">, answer = finalText) =>
    passes(fixture.expect, { ...run(call), finalText: answer });
  assert.isTrue(grade(worker));
  assert.isFalse(grade({ ...worker, failed: true }));
  assert.isFalse(grade({ ...worker, input: { ...worker.input, topLevel: true } }));
  assert.isFalse(grade({ ...worker, input: { ...worker.input, interactionMode: "plan" } }));
  assert.isFalse(
    grade({
      ...worker,
      input: { ...worker.input, message: "Use t3_thread_send to call me back." },
    }),
  );
  assert.isFalse(grade(worker, "The worker will finish later."));
});
