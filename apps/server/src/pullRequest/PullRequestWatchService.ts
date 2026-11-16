import {
  CommandId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PullRequestUnavailableError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import {
  resolveTarget,
  type PullRequestTarget,
  type PullRequestTargetError,
  type ResolvedTarget,
} from "./pullRequestTarget.ts";
import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestNotOpenError extends Schema.TaggedError<PullRequestNotOpenError>()(
  "PullRequestNotOpenError",
  { state: Schema.String },
) {
  override get message(): string {
    return `The pull request is ${this.state}, so there is nothing to watch.`;
  }
}

export class PullRequestWatchFromSubagentError extends Schema.TaggedError<PullRequestWatchFromSubagentError>()(
  "PullRequestWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This child execution cannot own a PR watch. End your turn with an unfinished handoff asking your parent to own the watch, without polling.";
  }
}

export class PullRequestWatchRestartRefusedError extends Schema.TaggedError<PullRequestWatchRestartRefusedError>()(
  "PullRequestWatchRestartRefusedError",
  { reason: Schema.Literals(["quiet", "unreadable"]) },
) {
  override get message(): string {
    return this.reason === "quiet"
      ? "Not watched again: this watch's quiet deadline already expired and the PR has had no activity since, so a new watch would expire the same way. The watch is still registered: it still wakes you on failed or passed checks, new comments or reviews, and conflicts, and a push restarts its timer, so after a push just run the gate check. Otherwise report the pending gates as a blocker and call unwatch_pull_request. Pass restart: true only if the user asked you to keep waiting."
      : "Not watched again: T3 Code stopped this watch because it could not read the PR from the host, and a new watch would stop the same way. Check the PR yourself and report that T3 Code cannot read it as a blocker. Pass restart: true only if the user asked you to keep waiting.";
  }
}

export class PullRequestWatchThreadNotFoundError extends Schema.TaggedError<PullRequestWatchThreadNotFoundError>()(
  "PullRequestWatchThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestWatchService extends Context.Service<
  PullRequestWatchService,
  {
    readonly setWatching: (input: {
      readonly threadId: ThreadId;
      readonly target: PullRequestTarget;
      readonly watching: boolean;
      readonly callerHasExecution?: boolean | undefined;
      readonly quietTimeoutMinutes?: number | null | undefined;
      readonly restart?: boolean | undefined;
    }) => Effect.Effect<
      ResolvedTarget & { readonly watching: boolean; readonly wasWatching: boolean },
      | PullRequestWatchFailedError
      | PullRequestNotOpenError
      | PullRequestWatchFromSubagentError
      | PullRequestWatchRestartRefusedError
      | PullRequestWatchThreadNotFoundError
      | PullRequestTargetError
      | PullRequestUnavailableError
    >;
  }
>()("t3/pullRequest/PullRequestWatchService") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;

  const requireThread = Effect.fn("PullRequestWatchService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new PullRequestWatchThreadNotFoundError({ threadId });
    }
    return thread;
  });

  // Keep the registration span stable across the service extraction.
  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (input: {
    readonly threadId: ThreadId;
    readonly target: PullRequestTarget;
    readonly watching: boolean;
    readonly callerHasExecution?: boolean | undefined;
    readonly quietTimeoutMinutes?: number | null | undefined;
    readonly restart?: boolean | undefined;
  }) {
    const { watching } = input;
    const thread = yield* requireThread(input.threadId);
    const project = yield* projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })),
    );
    const target = yield* resolveTarget(input.target, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    if (
      watching &&
      thread.lineage.relationshipToParent === "subagent" &&
      thread.lineage.independent !== true &&
      input.callerHasExecution !== true
    ) {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    if (watching && input.restart !== true) {
      // A null dueAt means the quiet wake fired and nothing on the PR has restarted the timer since.
      if (before?.watch?.quietDeadline?.dueAt === null && input.quietTimeoutMinutes !== null)
        return yield* new PullRequestWatchRestartRefusedError({ reason: "quiet" });
      if (before?.watch === undefined && before?.endedWatch?.unreadable === true)
        return yield* new PullRequestWatchRestartRefusedError({ reason: "unreadable" });
    }
    if (watching && before?.watch === undefined) {
      yield* pullRequests
        .summary(
          {
            projectId: thread.projectId,
            host: target.host,
            repository: target.repository,
            number: target.number,
            allowStale: false,
          },
          { recoverTransientFailure: false, bypassCache: true },
        )
        .pipe(
          Effect.flatMap((summary) =>
            summary.state === "merged"
              ? Effect.fail(new PullRequestNotOpenError({ state: "merged" }))
              : Effect.void,
          ),
          Effect.catchTags({
            // Host and transport errors can recover while the watch is active.
            PullRequestOperationError: () => Effect.void,
          }),
        );
    }
    const uuid = yield* random.uuidV4().pipe(Effect.orDie);
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`server:mcp-pr-watch:${thread.id}:${uuid}`),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching && input.quietTimeoutMinutes !== undefined
          ? { quietTimeoutMinutes: input.quietTimeoutMinutes }
          : {}),
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new PullRequestWatchFailedError({ cause })),
        ),
      );
    const after = yield* requireThread(thread.id);
    return {
      ...target,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
  });

  return PullRequestWatchService.of({ setWatching });
});

export const layer = Layer.effect(PullRequestWatchService, make);
