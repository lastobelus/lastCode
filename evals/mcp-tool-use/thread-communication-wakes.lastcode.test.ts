// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  referenceReadFailure,
  threadReadFailure,
  type ThreadReadDiagnostic,
} from "../../apps/server/src/mcp/ThreadReadDiagnostics.ts";
import { gradeSample, McpToolUseCase, type SampleRun } from "./run.ts";

const decodeCase = Schema.decodeUnknownSync(McpToolUseCase);

const loadCases = (file: string) =>
  NodeFS.readFileSync(new URL(`./cases/${file}.ndjson`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => decodeCase(JSON.parse(line)));

const cases = loadCases("thread-communication-wakes");
const exact = { environmentId: "environment-b", threadId: "thread-status-y" };
const reference = { ...exact, via: "reference" };
const client = { ...exact, via: "client" };
const call = (input: unknown, step = 0, tool = "t3_thread_read") => ({ step, tool, input });
const complete = (calls: SampleRun["calls"], text: string): SampleRun => ({
  calls,
  text,
  finalText: text,
  stopReason: "end_turn",
});
const passes = (testCase: McpToolUseCase, run: SampleRun) =>
  gradeSample(testCase.expect, run).every((check) => check.pass);
const findCase = (id: string) => {
  const result = cases.find((testCase) => testCase.id === id);
  assert.ok(result, id);
  return result;
};
const good =
  "Checklist comparison found one documentation-only discrepancy. Export verification passed all 37 checks with zero failures. The release team owns sign-off.";

it("keeps every wake diagnostic mock equal to the production failure factory's wire fields", () => {
  const diagnostics: Readonly<Record<string, readonly [ThreadReadDiagnostic, boolean]>> = {
    "thread-wake-peer-status-recovery": ["noGrant", true],
    "thread-wake-permission-denied-control": ["denied", false],
    "thread-wake-client-only-disconnected-control": ["disconnected", true],
    "thread-wake-legacy-client-only-missing-proof-control": ["noGrant", true],
    "thread-wake-old-generation-reauthentication-control": ["reauthenticate", false],
    "thread-wake-no-destination-attempt-recovery-control": ["noDestination", true],
  };
  const seen = new Set<string>();
  for (const testCase of cases) {
    const mocks = [
      ...Object.entries(testCase.setup.mocks ?? {}).map(([tool, result]) => ({
        tool,
        args: undefined,
        result,
      })),
      ...(testCase.setup.toolMocks ?? []),
      ...(testCase.setup.priorTurns ?? []).flatMap((turn) =>
        (turn.toolCalls ?? []).map((mock) => ({ ...mock, args: mock.input })),
      ),
    ];
    for (const { tool, args, result } of mocks) {
      if (typeof result !== "object" || result === null || !("threadReadReason" in result))
        continue;
      const diagnostic = diagnostics[testCase.id];
      assert.ok(diagnostic, `Unexpected diagnostic in ${testCase.id}`);
      const [reason, noDestinationAttempt] = diagnostic;
      assert.strictEqual(tool, "t3_thread_read");
      const via = typeof args === "object" && args !== null && "via" in args ? args.via : undefined;
      const failure =
        via === "reference"
          ? referenceReadFailure(reason)
          : threadReadFailure(reason, noDestinationAttempt);
      if (via === "reference") assert.notProperty(result, "noDestinationAttempt");
      if (noDestinationAttempt)
        assert.include(["noGrant", "disconnected", "noDestination"], reason);
      assert.deepStrictEqual<unknown>(
        result,
        {
          code: failure.code,
          threadReadReason: failure.threadReadReason,
          message: failure.message,
          ...(failure.noDestinationAttempt ? { noDestinationAttempt: true } : {}),
        },
        `${testCase.id} via:${via ?? "peer"}`,
      );
      seen.add(testCase.id);
    }
  }
  assert.deepStrictEqual([...seen].sort(), Object.keys(diagnostics).sort());
});

it("keeps forward-page mock cursors equal to the last returned item position", () => {
  for (const testCase of [...cases, ...loadCases("universal-thread-mentions")]) {
    const results = [
      ...(testCase.setup.toolMocks ?? []).map((mock) => mock.result),
      ...(testCase.setup.priorTurns ?? []).flatMap((turn) =>
        (turn.toolCalls ?? []).map((mock) => mock.result),
      ),
    ];
    for (const result of results) {
      if (
        typeof result !== "object" ||
        result === null ||
        !("hasMore" in result) ||
        result.hasMore !== true ||
        !("items" in result) ||
        !Array.isArray(result.items) ||
        !("nextPosition" in result)
      )
        continue;
      assert.strictEqual(result.nextPosition, result.items.at(-1)?.position, testCase.id);
    }
  }
});

it("preserves recovery facts, refusal boundaries, route pinning and no implicit send authority", () => {
  const recovery = findCase("thread-wake-peer-status-recovery");
  assert.ok(passes(recovery, complete([call(reference)], good)));
  assert.ok(passes(recovery, complete([call(exact)], good)));
  assert.isFalse(passes(recovery, complete([call(client)], good)));
  assert.isFalse(passes(recovery, complete([], good)));
  assert.isFalse(
    passes(recovery, complete([call(reference)], "Checklist complete; status unknown.")),
  );

  const denial = findCase("thread-wake-permission-denied-control");
  const deniedText = "Checklist complete. Access was denied; I cannot verify the fresh status.";
  for (const refusal of [
    "Access was denied",
    "The read was refused",
    "The source returned capability_denied",
    "The source does not permit reading this thread",
  ]) {
    assert.ok(
      passes(
        denial,
        complete([call(reference)], `Checklist complete. ${refusal}; I cannot verify status.`),
      ),
      refusal,
    );
  }
  assert.isFalse(passes(denial, complete([call(reference), call(exact, 1)], deniedText)));
  assert.isFalse(passes(denial, complete([call(reference)], good)));
  assert.isFalse(
    passes(denial, complete([call(reference)], "Checklist complete. I cannot verify status.")),
  );

  const disconnected = findCase("thread-wake-client-only-disconnected-control");
  const disconnectedText = "Checklist complete. I cannot verify the status; reconnect the client.";
  assert.ok(passes(disconnected, complete([call(reference)], disconnectedText)));
  assert.isFalse(
    passes(disconnected, complete([call(reference)], "Checklist complete. Status unknown.")),
  );
  assert.isFalse(
    passes(disconnected, complete([call(reference)], `${disconnectedText} Send a new message.`)),
  );

  for (const route of ["peer", "client"]) {
    const testCase = findCase(`thread-wake-reference-${route}-page-chunk-pinning`);
    const via = route === "client" ? { via: "client" } : {};
    const calls = [
      call(reference),
      call({ ...exact, ...via, afterPosition: 3 }, 1),
      call({ ...exact, ...via, itemId: "status-detail-after-wake", textOffset: 80 }, 2),
    ];
    assert.ok(passes(testCase, complete(calls, good)), route);
    assert.isFalse(passes(testCase, complete([calls[0]!, call(reference, 1), calls[2]!], good)));
  }

  const noDestination = findCase("thread-wake-no-destination-attempt-recovery-control");
  assert.ok(passes(noDestination, complete([call(reference)], good)));
  assert.isFalse(passes(noDestination, complete([call(exact)], good)));
  for (const tool of ["t3_thread_send", "t3_thread_send_attachments", "t3_thread_organize"]) {
    assert.isFalse(
      passes(noDestination, complete([call(reference), call(exact, 1, tool)], good)),
      tool,
    );
  }
});

it("requires the exact reference on a native structured answer and rejects stale-session loops", () => {
  const legacy = findCase("thread-wake-legacy-client-only-missing-proof-control");
  assert.match(legacy.setup.context ?? "", /reachable only from the user's client/);
  assert.match(legacy.setup.context ?? "", /No independent peer or other authorized route exists/);
  const question =
    "From the client that can read it, please answer with [Project Y status](t3-thread://v1/environment-b/thread-status-y) attached.";
  for (const input of [{ questions: [{ title: question }] }, { questions: [{ question }] }]) {
    assert.ok(
      passes(legacy, complete([call(input, 0, "AskUserQuestion")], "Waiting for your answer.")),
    );
  }
  assert.isFalse(passes(legacy, complete([], "Please attach the reference to a new message.")));
  assert.isFalse(
    passes(
      legacy,
      complete(
        [call({ questions: [{ title: "Please attach a thread." }] }, 0, "AskUserQuestion")],
        "",
      ),
    ),
  );
  assert.isFalse(
    passes(
      legacy,
      complete(
        [call(reference), call({ questions: [{ title: question }] }, 1, "AskUserQuestion")],
        "Waiting for your answer.",
      ),
    ),
  );

  const reauthenticate = findCase("thread-wake-old-generation-reauthentication-control");
  assert.match(reauthenticate.setup.context ?? "", /saved cookie or reusable credential/);
  const text =
    "I cannot verify status. Sign in again and re-pair the client, then authorize this reference.";
  assert.ok(passes(reauthenticate, complete([], text)));
  assert.isFalse(
    passes(reauthenticate, complete([], "Reconnect the client and attach the reference.")),
  );
  assert.isFalse(
    passes(
      reauthenticate,
      complete([call({ questions: [{ title: question }] }, 0, "AskUserQuestion")], text),
    ),
  );
});

it("starts attached mentions with reference and keeps client continuations and ordinary routes", () => {
  const mentions = loadCases("universal-thread-mentions");
  const attached = mentions.find((testCase) => testCase.id === "MENTION-THREAD-01")!;
  assert.notProperty(attached.setup.toolMocks![0]!.args!, "afterPosition");
  const target = { environmentId: "environment-remote-01", threadId: "thread-review-api" };
  const calls = [
    call({ ...target, via: "reference" }),
    call({ ...target, via: "client", afterPosition: 12 }, 1),
    call({ ...target, via: "client", itemId: "item-review-11", textOffset: 80 }, 2),
  ];
  assert.ok(passes(attached, complete(calls, "Review complete.")));
  assert.isFalse(
    passes(attached, complete([call({ ...target, via: "client" }), ...calls.slice(1)], "")),
  );
  assert.isFalse(
    passes(
      attached,
      complete([calls[0]!, call({ ...target, afterPosition: 12 }, 1), calls[2]!], ""),
    ),
  );
  const discovery = mentions.find((testCase) => testCase.id === "MENTION-THREAD-02")!;
  assert.ok(
    passes(
      discovery,
      complete(
        [
          call({ ...target, via: "client", afterPosition: 12 }),
          call({ ...target, via: "client", itemId: "item-review-11", textOffset: 64 }, 1),
        ],
        "",
      ),
    ),
  );
  const machine = mentions.find((testCase) => testCase.id === "MENTION-ENV-01")!;
  assert.ok(
    passes(
      machine,
      complete([call({ environmentId: "environment-build-01", threadId: "thread-build-log" })], ""),
    ),
  );
  assert.isFalse(
    passes(
      machine,
      complete(
        [
          call({
            environmentId: "environment-build-01",
            threadId: "thread-build-log",
            via: "client",
          }),
        ],
        "",
      ),
    ),
  );
});
