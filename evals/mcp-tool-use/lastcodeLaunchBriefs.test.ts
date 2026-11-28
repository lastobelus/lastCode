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

const decodeCase = Schema.decodeUnknownSync(McpToolUseCase);
const fixtures = NodeFS.readFileSync(
  new URL("./cases/launch-callbacks.ndjson", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => decodeCase(JSON.parse(line)));
const fixtureFor = (id: string) => fixtures.find((entry) => entry.id === id)!;

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
  const fixture = fixtureFor("lc-lower-mode-return-unavailable");
  const environmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const destination = `t3-thread://v2/${environmentId}/t-1`;
  const link = `[Benchmark worker](${destination})`;
  const worker = {
    ...launch("Report the benchmark result in your own thread."),
    input: {
      environmentId,
      runtimeMode: "approval-required",
      message: "Report the benchmark result in your own thread.",
    },
    output: JSON.stringify({ threadId: "t-1", link, runId: "run-1", status: "starting" }),
    failed: false,
  };
  const handoff = (target: string) =>
    `The worker has fewer permissions. Read its result with t3_thread_read at ${target}.`;
  const finalText = handoff(link);
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
  assert.isFalse(grade(worker, handoff("[Worker](t3-thread://v2/fixture/thread/extra)")));
  assert.isFalse(grade(worker, handoff(link.replace("/t-1", "/t-2"))));
  assert.isFalse(grade(worker, handoff(link.replace(environmentId, local))));
  assert.isFalse(grade(worker, handoff(`\`${destination}\``)));
  assert.isFalse(
    grade({
      ...worker,
      input: { ...worker.input, message: "Message your launcher with the result." },
    }),
  );
});

it("requires an instruction to send the callback in the positive callback fixtures", () => {
  const release = fixtureFor("lc-landing-threads-call-back");
  const remote = fixtureFor("lc-remote-thread-calls-back-across-environments");
  const destination =
    "with threadId 33333333-3333-4333-8333-333333333333, environmentId " +
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee, mode queue, and a stable clientRequestId per event.";
  const grade = (instruction: string) =>
    [release, remote].map((fixture) =>
      passes(
        fixture.expect,
        fixture === release
          ? run(launch(`Land PR 41. ${instruction}`), launch(`Land PR 42. ${instruction}`))
          : run(launch(instruction, { environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })),
      ),
    );
  assert.deepEqual(grade(`When done, call t3_thread_send ${destination}`), [true, true]);
  assert.deepEqual(
    grade(
      `When done, call t3_thread_send with mode steer. Example values for tests: ${destination}`,
    ),
    [false, false],
  );
  assert.deepEqual(grade(`Do not call t3_thread_send ${destination}`), [false, false]);
  assert.deepEqual(grade(`Thread notes mention t3_thread_send ${destination}`), [false, false]);
});

it("rejects indirect callbacks when a new thread is for the user to drive", () => {
  const controls = [
    [fixtureFor("lc-control-user-drives-thread"), "Update README badges"],
    [fixtureFor("lc-control-thread-to-follow"), "Fix flaky upload test"],
  ] as const;
  for (const [fixture, title] of controls) {
    const grade = (message: string) =>
      passes(fixture.expect, run({ ...launch(message), input: { title, message } }));
    assert.isTrue(grade("Work with the user in this thread."));
    assert.isFalse(grade("Message your parent with the result."));
  }
});

it("requires the worker to send with the event key from its brief", () => {
  const fixture = fixtureFor("lc-child-calls-back-across-environments");
  const commit = { tool: "Bash", input: { command: "git commit -m 'fix: spell receive'" } };
  const callback = send("44444444-4444-4444-8444-444444444444", "Done", {
    environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  const grade = (clientRequestId?: string) =>
    passes(
      fixture.expect,
      run(commit, {
        ...callback,
        input: { ...callback.input, mode: "queue", clientRequestId },
        failed: false,
      }),
    );
  assert.isTrue(grade("mail-typo-done"));
  assert.isFalse(grade("wrong-event"));
  assert.isFalse(grade());
});
