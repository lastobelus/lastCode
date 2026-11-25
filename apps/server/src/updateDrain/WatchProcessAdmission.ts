import { type UpdateDrainError, type VcsError, VcsProcessSpawnError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

interface CommandContext {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
}

type AdmitWatchProcess = <A, R>(
  input: CommandContext,
  effect: Effect.Effect<A, VcsError, R>,
) => Effect.Effect<A, VcsError, R>;

/** Guards subprocesses from watch reads and subscriptions during tool maintenance. */
export const WatchProcessAdmission = Context.Reference<AdmitWatchProcess>(
  "t3/updateDrain/WatchProcessAdmission",
  { defaultValue: () => (_input, effect) => effect },
);

export const guardWatchProcess =
  (
    admit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | UpdateDrainError, R>,
  ): AdmitWatchProcess =>
  (input, effect) =>
    admit(effect).pipe(
      Effect.catchTags({
        UpdateDrainError: (cause) =>
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            argumentCount: input.args.length,
            cause,
          }),
      }),
    );
