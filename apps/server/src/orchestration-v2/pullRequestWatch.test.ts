import {
  SourceControlProviderKind,
  ThreadPullRequestWatch as WatchSchema,
  type PullRequestCheck,
  type PullRequestComment,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch as evaluate,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

// These cases read the head once or at one moment, so the no-checks notice never comes due.
const evaluatePullRequestWatch = (
  ...args: Parameters<typeof evaluate> extends [...infer Head, number] ? Head : never
) => evaluate(...args, 0);

const decodeWatch = Schema.decodeUnknownSync(WatchSchema);

const STARTED = "2026-10-02T12:00:00.000Z";

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  reactionKeys: [],
  reactionCounts: {},
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  provider: SourceControlProviderKind.make("github"),
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (
  login: string,
  createdAt: string,
  body = "Please rename this.",
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

const noRemarks: ReadonlyArray<PullRequestComment> = [];

describe("evaluatePullRequestWatch", () => {
  it("reports named reactions on old own comments once, including after a durable replay", () => {
    const own = {
      ...remark("agent-user", "2026-10-01T12:00:00Z", "Please review."),
      reactions: [
        {
          content: "thumbs-up" as const,
          count: 1,
          actors: ["review-bot"],
          viewerHasReacted: false,
        },
      ],
    };
    const passed = detail({ checks: [check("lint", "success")] });
    const baseline = evaluatePullRequestWatch(watch(), passed, []);
    const report = evaluatePullRequestWatch(baseline.next, passed, [own]);
    assert.deepEqual(report.changes, [
      {
        kind: "reactions",
        reactions: [{ remark: own, content: "thumbs-up", actor: "review-bot" }],
      },
    ]);
    assert.equal(report.next.wakes, 1);
    const replay = decodeWatch(JSON.parse(JSON.stringify(report.next)));
    assert.deepEqual(evaluatePullRequestWatch(replay, passed, [own]).changes, []);
    const missing = evaluatePullRequestWatch(replay, passed, null);
    assert.deepEqual(missing.next.reactionKeys, replay.reactionKeys);
    const partial = evaluatePullRequestWatch(missing.next, passed, []);
    assert.deepEqual(evaluatePullRequestWatch(partial.next, passed, [own]).changes, []);
    assert.deepEqual(
      evaluatePullRequestWatch(replay, { ...passed, headSha: "bbbbbbbbbb" }, [own]).changes.map(
        (change) => change.kind,
      ),
      ["checks-passed"],
    );
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: passed.headSha ?? null,
      report,
    });
    assert.include(message.text, 'review-bot: thumbs-up on "Please review."');
    assert.equal(message.notification.summary, "#12: new reactions");
  });

  it("ignores own reactions and reactions on other people's comments", () => {
    const self = {
      ...remark("agent-user", STARTED),
      reactions: [
        { content: "thumbs-up" as const, count: 1, actors: ["AGENT-USER"], viewerHasReacted: true },
      ],
    };
    const other = {
      ...remark("reviewer", "2026-10-01T12:00:00Z"),
      reactions: [
        {
          content: "thumbs-up" as const,
          count: 1,
          actors: ["another-reviewer"],
          viewerHasReacted: false,
        },
      ],
    };
    const unnamed = {
      ...self,
      reactions: [{ ...self.reactions[0]!, actors: [], viewerHasReacted: false }],
    };
    const report = evaluatePullRequestWatch(watch(), detail(), [self, other]);
    assert.deepEqual(report.changes, []);
    assert.deepEqual(report.next.reactionKeys, []);
    assert.deepEqual(report.next.reactionCounts, {});
    const unknownOwn = evaluatePullRequestWatch(
      watch(),
      detail({ viewer: undefined, author: null }),
      [{ ...unnamed, createdAt: "2026-10-01T12:00:00Z" }],
    );
    assert.deepEqual(unknownOwn.changes, []);
  });

  it("counts reactors past the named page once, keeping the total across pushes and gaps", () => {
    const passed = detail({ checks: [check("lint", "success")] });
    const named = Array.from({ length: 10 }, (_, index) => `reviewer-${index}`);
    const own = (count: number, viewerHasReacted = false): PullRequestComment => ({
      ...remark("agent-user", "2026-10-01T12:00:00Z", "Please review."),
      reactions: [{ content: "heart", count, actors: named, viewerHasReacted }],
    });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true, passedChecks: ["lint"] });
    const first = evaluatePullRequestWatch(told, passed, [own(10)]);
    assert.equal(first.changes.length, 1);
    assert.deepEqual(first.next.reactionCounts, {});

    // An eleventh reactor moves only the total; the named page stays the same ten.
    const eleventh = evaluatePullRequestWatch(first.next, passed, [own(11)]);
    assert.deepEqual(eleventh.changes, [
      {
        kind: "reactions",
        reactions: [{ remark: own(11), content: "heart", actor: null, count: 1 }],
      },
    ]);
    const message = pullRequestWatchMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      baseBranch: "main",
      headSha: passed.headSha ?? null,
      report: eleventh,
    });
    assert.include(message.text, "- 1 new reaction on your comments:");
    assert.include(message.text, '1 person the host did not name: heart on "Please review."');

    // The same total, a removal, and its return are not news, nor is the agent's own reaction,
    // across a durable replay, an unreadable conversation, and a push.
    const replay = decodeWatch(JSON.parse(JSON.stringify(eleventh.next)));
    const quiet = [[own(11)], [own(10)], null, [own(11)], [own(12, true)]].reduce(
      (state, remarks) => {
        const report = evaluatePullRequestWatch(state, passed, remarks);
        assert.deepEqual(report.changes, []);
        return report.next;
      },
      replay,
    );
    const pushed = evaluatePullRequestWatch(quiet, { ...passed, headSha: "bbbbbbbbbb" }, [
      own(13, true),
    ]);
    assert.deepEqual(pushed.changes, [
      { kind: "checks-passed", count: 1, required: false },
      {
        kind: "reactions",
        reactions: [{ remark: own(13, true), content: "heart", actor: null, count: 1 }],
      },
    ]);

    // A host that counts reactions it names no one for reports them the same way, once.
    const nameless = { ...own(2), reactions: [{ ...own(2).reactions![0]!, actors: [] }] };
    const unnamed = evaluatePullRequestWatch(told, passed, [nameless]);
    assert.deepEqual(unnamed.changes, [
      {
        kind: "reactions",
        reactions: [{ remark: nameless, content: "heart", actor: null, count: 2 }],
      },
    ]);
    assert.deepEqual(evaluatePullRequestWatch(unnamed.next, passed, [nameless]).changes, []);
  });

  it("defaults persisted watches without reaction keys and bounds reaction-only wakes", () => {
    const { reactionKeys: _keys, reactionCounts: _counts, ...legacy } = watch();
    const saved = decodeWatch(legacy);
    assert.deepEqual(saved.reactionKeys, []);
    assert.deepEqual(saved.reactionCounts, {});
    const own = {
      ...remark("agent-user", STARTED),
      reactions: [
        { content: "thumbs-up" as const, count: 1, actors: ["reviewer"], viewerHasReacted: false },
      ],
    };
    const report = evaluatePullRequestWatch(
      watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 }),
      detail(),
      [own],
    );
    assert.isTrue(report.exhausted);
  });

  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(evaluatePullRequestWatch(lint.next, first, noRemarks).changes, []);

    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks);
    assert.equal(evaluatePullRequestWatch(rerun.next, second, noRemarks).changes.length, 1);

    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(evaluatePullRequestWatch(test.next, pushed, noRemarks).changes.length, 1);
  });

  it("reports passed once the required checks pass, whatever the others do", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const green = detail({
      checks: [required("test", "success"), required("lint", "success"), check("bot", "pending")],
    });
    const passed = evaluatePullRequestWatch(watch(), green, noRemarks);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(passed.next, green, noRemarks).changes, []);

    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(evaluatePullRequestWatch(watch(), plain, noRemarks).changes, []);
  });

  it("reports passed again when a required check shows up already passed", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const tests = detail({
      checks: [required("Tests", "success"), check("Smoke Tests", "pending")],
    });
    const first = evaluatePullRequestWatch(watch(), tests, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    const gated = detail({
      checks: [
        required("Tests", "success"),
        check("Smoke Tests", "success"),
        required("Smoke Tests Gate", "success"),
      ],
    });
    const second = evaluatePullRequestWatch(first.next, gated, noRemarks);
    assert.deepEqual(second.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(second.next, gated, noRemarks).changes, []);

    const pending = detail({
      checks: [required("Tests", "success"), required("Smoke Tests Gate", "pending")],
    });
    const waiting = evaluatePullRequestWatch(first.next, pending, noRemarks);
    assert.deepEqual(waiting.changes, []);
    assert.deepEqual(evaluatePullRequestWatch(waiting.next, gated, noRemarks).changes, [
      { kind: "checks-passed", count: 2, required: true },
    ]);
  });

  // regression: #16208 PR watches burned GitHub's rate limit and gave up
  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluatePullRequestWatch(
      watch(),
      detail({ checks: [check("test", "success")] }),
      noRemarks,
    );
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(first.next, both, noRemarks).changes, []);
  });

  it("does not wake a watch saved before passed checks were recorded", () => {
    const green = detail({ checks: [{ ...check("test", "success"), required: true }] });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true });
    const saved = evaluatePullRequestWatch(told, green, noRemarks);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later pass when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluatePullRequestWatch(watch(), detail(), null);
    assert.deepEqual(partial.changes, []);
    assert.equal(
      evaluatePullRequestWatch(partial.next, detail(), comments).changes[0]?.kind,
      "remarks",
    );
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluatePullRequestWatch(watch(), detail(), [first]);
    const again = evaluatePullRequestWatch(reported.next, detail(), [first, late]);
    assert.deepEqual(again.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(again.next.remarkIds, [first.id, "late"]);
  });

  it("reports edits after the watermark once and counts them toward the wake limit", () => {
    const old = remark("greptile[bot]", "2026-10-02T11:00:00Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarkIds: [old.id],
      wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
    });
    assert.deepEqual(evaluatePullRequestWatch(watching, detail(), [old]).changes, []);
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluatePullRequestWatch(watching, detail(), [edited]);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.deepEqual(report.next.remarkIds, [old.id]);
    assert.isTrue(report.exhausted);
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited]).changes, []);
    const late = { ...edited, id: "late" };
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited, late]).changes, [
      { kind: "remarks", remarks: [late] },
    ]);
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluatePullRequestWatch(watch(), failed, noRemarks);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluatePullRequestWatch(reported.next, detail({ checks: [] }), noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(unreadable.next, failed, noRemarks).changes, []);
  });

  it("wakes for the pull request's author when the agent is someone else", () => {
    const contributor = detail({ author: { login: "contributor", name: null, avatarUrl: null } });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(watch(), contributor, [reply]).changes, [
      { kind: "remarks", remarks: [reply] },
    ]);
    const noViewer = detail({ viewer: undefined, author: contributor.author });
    assert.deepEqual(evaluatePullRequestWatch(watch(), noViewer, [reply]).changes, []);
  });

  it("reports remarks from others once and never the agent's own", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    const report = evaluatePullRequestWatch(watch(), detail(), comments);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), comments).changes, []);
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    const recomputing = evaluatePullRequestWatch(
      first.next,
      detail({ mergeability: "unknown" }),
      noRemarks,
    );
    assert.deepEqual(
      evaluatePullRequestWatch(recomputing.next, conflicting, noRemarks).changes,
      [],
    );
    const clean = evaluatePullRequestWatch(first.next, detail(), noRemarks);
    assert.deepEqual(evaluatePullRequestWatch(clean.next, conflicting, noRemarks).changes, [
      { kind: "conflicting" },
    ]);
  });

  it("does not spend the comment wake limit on check results", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(
      tired,
      detail({ checks: [check("lint", "failure")] }),
      noRemarks,
    );
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("stops after the wake limit unless the head moves", () => {
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.isTrue(evaluatePullRequestWatch(tired, detail(), comments).exhausted);
    const pushed = evaluatePullRequestWatch(tired, detail({ headSha: "cccccccccc" }), comments);
    assert.isFalse(pushed.exhausted);
    assert.equal(pushed.next.wakes, 1);
  });

  const anHourLater = (
    first: ThreadPullRequestWatch,
    read: Detail,
  ): ReadonlyArray<ReadonlyArray<string>> => {
    const kinds: Array<ReadonlyArray<string>> = [];
    let current = first;
    for (let minute = 0; minute <= 60; minute += 10) {
      const { changes, next } = evaluate(current, read, noRemarks, minute * 60_000);
      kinds.push(changes.map((change) => change.kind));
      current = next;
    }
    return kinds;
  };

  it("does not tell a watch saved before the no-checks clock that its seen head has none", () => {
    // Such a watch may have seen this head's checks pending, which records nothing.
    const legacy = watch({ headSha: "aaaaaaaaaa" });
    assert.isTrue(anHourLater(legacy, detail({ checks: [] })).every((kinds) => kinds.length === 0));
    const pushed = anHourLater(legacy, detail({ headSha: "bbbbbbbbbb", checks: [] }));
    assert.deepEqual(pushed.flat(), ["no-checks"]);
  });

  it("never reports missing checks on a host whose checks it cannot read", () => {
    const azure = detail({
      provider: SourceControlProviderKind.make("azure-devops"),
      checks: [],
    });
    assert.isTrue(anHourLater(watch(), azure).every((kinds) => kinds.length === 0));
  });
});
