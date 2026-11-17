// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  exhaustedReferenceFailure,
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
  const diagnostics: Readonly<Record<string, readonly [ThreadReadDiagnostic, boolean, string?]>> = {
    "thread-wake-peer-status-recovery": ["noGrant", true],
    "thread-wake-permission-denied-control": ["denied", false],
    "thread-wake-client-only-disconnected-control": ["disconnected", true],
    "thread-wake-legacy-client-only-missing-proof-control": ["noGrant", true],
    "thread-wake-old-generation-reauthentication-control": ["reauthenticate", false],
    "thread-wake-no-destination-attempt-recovery-control": ["noDestination", true],
    "thread-wake-expired-peer-link-recovery": ["disconnected", true, "environment-b"],
    "thread-wake-answered-read-lost-grant": ["lostGrant", false],
    "thread-wake-revoked-client-expired-peer-link": ["revoked", true, "environment-b"],
    "thread-wake-idle-expired-reference-grant": ["expiredGrant", true],
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
      const [reason, noDestinationAttempt, expiredPeerEnvironmentId] = diagnostic;
      assert.strictEqual(tool, "t3_thread_read");
      const via = typeof args === "object" && args !== null && "via" in args ? args.via : undefined;
      const failure =
        via === "reference"
          ? exhaustedReferenceFailure(
              referenceReadFailure(reason, noDestinationAttempt),
              expiredPeerEnvironmentId === undefined
                ? undefined
                : EnvironmentId.make(expiredPeerEnvironmentId),
            )
          : threadReadFailure(reason, noDestinationAttempt);
      if (via === "reference") assert.notProperty(result, "noDestinationAttempt");
      if (noDestinationAttempt)
        assert.include(
          ["noGrant", "disconnected", "noDestination", "revoked", "expiredGrant"],
          reason,
        );
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

it("requires both client recovery and expired-link renewal without another read or mutation", () => {
  const expired = findCase("thread-wake-expired-peer-link-recovery");
  const report =
    "Checklist complete: one documentation-only discrepancy. I cannot verify the latest status because the client is disconnected. Reconnect that client, or renew the existing expired outgoing read link to Environment B.";
  assert.ok(passes(expired, complete([call(reference)], report)));
  assert.isFalse(passes(expired, complete([], report)));
  assert.isFalse(passes(expired, complete([call(client)], report)));
  assert.isFalse(passes(expired, complete([call(exact)], report)));
  assert.isFalse(passes(expired, complete([call(reference), call(reference, 1)], report)));
  assert.isFalse(
    passes(
      expired,
      complete(
        [call(reference)],
        "Checklist complete. I cannot verify status; reconnect the disconnected client.",
      ),
    ),
  );
  assert.isFalse(
    passes(
      expired,
      complete(
        [call(reference)],
        "Checklist complete. I cannot verify status; renew the existing expired read link.",
      ),
    ),
  );
  assert.isFalse(passes(expired, complete([call(reference)], `${report} ${good}`)));
  assert.isFalse(
    passes(expired, complete([call(reference)], `${report} I will renew the link myself.`)),
  );
  for (const tool of [
    "t3_thread_send",
    "t3_thread_send_attachments",
    "t3_thread_organize",
    "t3_environment_link",
    "t3_thread_search",
  ]) {
    assert.isFalse(
      passes(expired, complete([call(reference), call(exact, 1, tool)], report)),
      tool,
    );
  }
  assert.isFalse(
    passes(
      expired,
      complete(
        [call(reference), call({ command: "lastcode-thread read thread-status-y" }, 1, "Bash")],
        report,
      ),
    ),
  );
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
  const sessionQuestion =
    "Sign in and re-pair the client. From the new session on a client that can read it, attach [Project Y status](t3-thread://v1/environment-b/thread-status-y) to your answer.";
  assert.ok(
    passes(
      reauthenticate,
      complete([call({ questions: [{ question: sessionQuestion }] }, 0, "AskUserQuestion")], text),
    ),
  );
  assert.isFalse(passes(reauthenticate, complete([], text)));
  assert.isFalse(
    passes(reauthenticate, complete([], "Reconnect the client and attach the reference.")),
  );
  assert.isFalse(
    passes(
      reauthenticate,
      complete([call({ questions: [{ title: question }] }, 0, "AskUserQuestion")], text),
    ),
  );
  assert.isFalse(
    passes(
      reauthenticate,
      complete(
        [
          call(
            {
              questions: [{ question: "Sign in and re-pair, then confirm from the new session." }],
            },
            0,
            "AskUserQuestion",
          ),
        ],
        text,
      ),
    ),
  );
  assert.isFalse(
    passes(
      reauthenticate,
      complete(
        [
          call({ questions: [{ question: sessionQuestion }] }, 0, "AskUserQuestion"),
          call(client, 1),
        ],
        text,
      ),
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

it("requires an attached structured answer after an answered strict read loses its final grant", () => {
  const lost = findCase("thread-wake-answered-read-lost-grant");
  const link = "[Project Y status](t3-thread://v1/environment-b/thread-status-y)";
  const question = `Please answer with ${link} attached, from a client that can read it.`;
  const ask = (title: string, step = 0) =>
    call({ questions: [{ title }] }, step, "AskUserQuestion");
  const waiting =
    "Checklist comparison found one documentation-only discrepancy. Waiting for your answer; I cannot verify the fresh source status.";
  for (const input of [{ questions: [{ title: question }] }, { questions: [{ question }] }]) {
    assert.ok(passes(lost, complete([call(input, 0, "AskUserQuestion")], waiting)));
  }
  assert.isFalse(passes(lost, complete([], waiting)));
  // This fixture has a native question tool; the conditional provider fallback does not apply.
  assert.isFalse(passes(lost, complete([], `Attach ${link} to a new message from the client.`)));
  for (const badQuestion of [
    "Please answer with this reference attached from a client that can read it.",
    question.replace("[Project Y status]", "[Other status]"),
    question.replace("environment-b", "environment-c"),
    question.replace("thread-status-y", "thread-other"),
    question.replace(" attached", ""),
    question.replace("client", "session"),
  ]) {
    assert.isFalse(passes(lost, complete([ask(badQuestion)], waiting)), badQuestion);
  }
  for (const via of [undefined, "client", "reference"]) {
    assert.isFalse(
      passes(
        lost,
        complete([call({ ...exact, ...(via ? { via } : {}) }), ask(question, 1)], waiting),
      ),
      via ?? "peer",
    );
  }
  assert.isFalse(passes(lost, complete([ask(question), ask(question, 1)], waiting)));
  for (const invented of [
    good,
    "Export verification completed.",
    "The thread is missing.",
    "The retained grant was revoked.",
    "The client read grant had expired.",
    "The retained grant has expired.",
    "No destination request was sent.",
  ]) {
    assert.isFalse(passes(lost, complete([ask(question)], `${waiting} ${invented}`)), invented);
  }
  for (const tool of [
    "t3_thread_send",
    "t3_thread_send_attachments",
    "t3_thread_update",
    "t3_thread_organize",
    "t3_environment_link",
    "t3_thread_search",
    "task_status",
    "Edit",
  ]) {
    assert.isFalse(passes(lost, complete([call(exact, 0, tool), ask(question, 1)], waiting)), tool);
  }
  assert.isFalse(
    passes(
      lost,
      complete(
        [call({ command: "lastcode-thread read thread-status-y" }, 0, "Bash"), ask(question, 1)],
        waiting,
      ),
    ),
  );
  assert.isFalse(passes(lost, { calls: [ask(question)], text: waiting, stopReason: "max_steps" }));
  const diagnostic = threadReadFailure("lostGrant");
  assert.notProperty(diagnostic, "noDestinationAttempt");
  assert.include(diagnostic.message, "sent and answered");
  assert.include(diagnostic.message, "no recorded reason");
  assert.include(diagnostic.message, "does not show whether the grant was revoked or expired");
  assert.include(diagnostic.message, "If this provider cannot ask structured questions");
  assert.include(diagnostic.message, "attach the reference to a new message instead");
});

it("requires independent client reapproval and expired-link renewal choices after revoked selection", () => {
  const revoked = findCase("thread-wake-revoked-client-expired-peer-link");
  const report =
    "Checklist complete: one documentation-only discrepancy. I cannot verify fresh status. Either approve the client again in connection settings, then authorize this reference, or renew the existing expired outgoing read link to Environment B.";
  assert.ok(passes(revoked, complete([call(reference)], report)));
  assert.ok(
    passes(
      revoked,
      complete(
        [call(reference)],
        report.replace("authorize this reference", "attach this reference"),
      ),
    ),
  );
  assert.isFalse(passes(revoked, complete([], report)));
  for (const input of [exact, client, { ...reference, environmentId: "environment-c" }]) {
    assert.isFalse(passes(revoked, complete([call(input)], report)));
  }
  assert.isFalse(passes(revoked, complete([call(reference), call(reference, 1)], report)));
  for (const incomplete of [
    "Checklist complete. I cannot verify fresh status. Renew the existing expired read link.",
    "Checklist complete. I cannot verify fresh status. Approve the client and authorize this reference.",
    report.replace("approve the client again in connection settings, then ", ""),
    report.replace("then authorize this reference, ", ""),
    "Checklist complete. I cannot verify fresh status: client authorization has expired. Approve that client again or renew the existing expired read link, then I can read the reference.",
    report.replace("expired ", ""),
    report.replace("Either ", "").replace(", or renew", ", and renew"),
  ]) {
    assert.isFalse(passes(revoked, complete([call(reference)], incomplete)), incomplete);
  }
  assert.isFalse(passes(revoked, complete([call(reference)], `${report} ${good}`)));
  assert.isFalse(
    passes(revoked, complete([call(reference)], `${report} I will renew the link myself.`)),
  );
  for (const tool of [
    "t3_thread_send",
    "t3_thread_send_attachments",
    "t3_thread_update",
    "t3_thread_organize",
    "t3_environment_link",
    "t3_thread_list",
    "t3_thread_search",
    "AskUserQuestion",
    "Edit",
  ]) {
    assert.isFalse(
      passes(revoked, complete([call(reference), call(exact, 1, tool)], report)),
      tool,
    );
  }
  assert.isFalse(
    passes(
      revoked,
      complete(
        [call(reference), call({ command: "lastcode-thread read thread-status-y" }, 1, "Bash")],
        report,
      ),
    ),
  );
  assert.isFalse(
    passes(revoked, { calls: [call(reference)], text: report, stopReason: "max_steps" }),
  );
  const diagnostic = exhaustedReferenceFailure(
    referenceReadFailure("revoked", true),
    EnvironmentId.make("environment-b"),
  );
  assert.notProperty(diagnostic, "noDestinationAttempt");
  assert.include(diagnostic.message, 'This via: "reference" read already checked both routes');
  assert.include(diagnostic.message, "no request was sent");
  assert.include(diagnostic.message, "Wait for client reapproval before asking");
  assert.notInclude(diagnostic.message, "Do not retry this read through another route");
});

it("recovers an idle-expired grant with an attached exact-reference answer and no reapproval", () => {
  const expired = findCase("thread-wake-idle-expired-reference-grant");
  const link = "[Project Y status](t3-thread://v1/environment-b/thread-status-y)";
  const question = `Please answer with ${link} attached, from a client that can read it.`;
  const ask = (title: string, step = 1) =>
    call({ questions: [{ title }] }, step, "AskUserQuestion");
  const waiting =
    "Checklist comparison found one documentation-only discrepancy. I cannot verify the fresh source status; waiting for your attached answer.";
  for (const title of [
    question,
    `No client reapproval is needed. ${question}`,
    `From the client that can read it, attach ${link} to your answer.`,
  ]) {
    for (const input of [{ questions: [{ title }] }, { questions: [{ question: title }] }]) {
      assert.ok(
        passes(
          expired,
          complete(
            [call(reference), call(input, 1, "AskUserQuestion")],
            `${waiting} No client reapproval is needed; you do not need to reapprove the client.`,
          ),
        ),
        title,
      );
    }
  }
  assert.isFalse(passes(expired, complete([call(reference)], waiting)));
  assert.isFalse(passes(expired, complete([ask(question)], waiting)));
  assert.isFalse(passes(expired, complete([ask(question, 0), call(reference, 1)], waiting)));
  for (const input of [exact, client, { ...reference, threadId: "thread-other" }]) {
    assert.isFalse(passes(expired, complete([call(input), ask(question)], waiting)));
  }
  for (const badQuestion of [
    "Attach this reference to your answer from a client that can read it.",
    question.replace("[Project Y status]", "[Other status]"),
    question.replace("environment-b", "environment-c"),
    question.replace("thread-status-y", "thread-other"),
    question.replace(" attached", ""),
    question.replace("client", "session"),
    `${question} Please reapprove the client first.`,
    `${question} Please approve the client in connection settings.`,
    `${question} To restore access, approve this client again in connection settings.`,
  ]) {
    assert.isFalse(
      passes(expired, complete([call(reference), ask(badQuestion)], waiting)),
      badQuestion,
    );
  }
  for (const extra of [
    call(reference, 2),
    call(client, 2),
    call(exact, 2),
    ask(question, 2),
    ...[
      "t3_thread_send",
      "t3_thread_send_attachments",
      "t3_thread_update",
      "t3_thread_organize",
      "t3_thread_list",
      "t3_thread_search",
      "t3_environment_links",
      "t3_environment_link",
      "delegate_task",
      "task_status",
      "request_user_input",
      "request_user_input_async",
      "Edit",
    ].map((tool) => call(exact, 2, tool)),
    call({ command: "lastcode-thread read thread-status-y" }, 2, "Bash"),
  ]) {
    assert.isFalse(passes(expired, complete([call(reference), ask(question), extra], waiting)));
  }
  for (const wrongRecovery of [
    "Approve the client again in connection settings, then attach the reference.",
    "Please reapprove the client before answering.",
    "To restore access, approve this client again in its connection settings.",
    "You need to approve the client again.",
    "Client reapproval is required before attachment.",
    "I am waiting for client reapproval.",
    "The client's read authorization was revoked.",
    "Send a new message with the reference.",
    good,
  ]) {
    assert.isFalse(
      passes(expired, complete([call(reference), ask(question)], `${waiting} ${wrongRecovery}`)),
      wrongRecovery,
    );
  }
  assert.isFalse(
    passes(expired, {
      calls: [call(reference), ask(question)],
      text: waiting,
      stopReason: "max_steps",
    }),
  );
});
