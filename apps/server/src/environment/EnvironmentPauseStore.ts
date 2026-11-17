import {
  CommandId,
  EnvironmentPauseError,
  EnvironmentPauseSession,
  EnvironmentPauseTarget,
  MessageId,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";

const StoredTarget = Schema.Struct({
  ...EnvironmentPauseTarget.fields,
  pauseAttempt: NonNegativeInt,
  resumeAttempt: NonNegativeInt,
  pauseAccepted: Schema.Boolean,
  resumeAccepted: Schema.Boolean,
  /** An earlier successful Pause still needs Resume while another Pause is attempted. */
  resumeRequired: Schema.optional(Schema.Literal(true)),
  pauseCancelled: Schema.optional(Schema.Literal(true)),
  resumeCancelled: Schema.optional(Schema.Literal(true)),
  /** Pause must follow an outstanding Resume, even if the recipient becomes idle. */
  rePause: Schema.optional(Schema.Literals(["waiting", "required"])),
});
const StoredSession = Schema.Struct({
  ...EnvironmentPauseSession.fields,
  targets: Schema.Array(StoredTarget),
});
export type StoredSession = typeof StoredSession.Type;
const StoredState = Schema.NullOr(StoredSession);
const json = Schema.fromJsonString(StoredState);

/** Stable command and message identities survive reconnects and process loss. */
export function deliveryIdentity(
  session: StoredSession,
  target: StoredSession["targets"][number],
  direction: "pause" | "resume",
) {
  const id = `environment-pause:${session.id}:${target.threadId}:${direction}:${target[`${direction}Attempt`]}`;
  return { commandId: CommandId.make(id), messageId: MessageId.make(id) };
}

/** A later owner action retires control messages that have not reached the provider. */
export function environmentPauseDeliveryCancelled(
  session: StoredSession | null,
  messageId: MessageId,
) {
  const direction = /:(pause|resume):\d+$/.exec(messageId)?.[1] as "pause" | "resume" | undefined;
  if (!messageId.startsWith("environment-pause:") || direction === undefined) return false;
  return (
    session === null ||
    (direction === "pause" ? session.phase === "resuming" : session.phase !== "resuming") ||
    !session.targets.some(
      (target) =>
        deliveryIdentity(session, target, direction).messageId === messageId &&
        target[direction] !== "unavailable",
    )
  );
}

export class EnvironmentPauseStore extends Context.Service<
  EnvironmentPauseStore,
  {
    readonly get: Effect.Effect<StoredSession | null>;
    readonly update: (
      f: (state: StoredSession | null) => StoredSession | null,
    ) => Effect.Effect<StoredSession | null, EnvironmentPauseError>;
    readonly recordDelivery: (
      messageId: MessageId,
      delivered: boolean | "cancelled",
      options?: {
        readonly onlyIfSuperseded?: StoredSession["targets"][number];
        readonly superseded?: true;
      },
    ) => Effect.Effect<void, EnvironmentPauseError>;
  }
>()("t3/environment/EnvironmentPauseStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "environment-pause.json");
  const load = fs.readFileString(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("null"),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(json)),
    Effect.mapError(
      (cause) => new EnvironmentPauseError({ operation: "persist", reason: "unavailable", cause }),
    ),
  );
  const state = yield* Ref.make(yield* load);
  const mutex = yield* Semaphore.make(1);
  const update = (f: (state: StoredSession | null) => StoredSession | null) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const next = f(current);
        if (next === current) return current;
        const contents = yield* Schema.encodeEffect(json)(next).pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentPauseError({ operation: "persist", reason: "unavailable", cause }),
          ),
        );
        yield* writeFileStringAtomically({ filePath, contents, mode: 0o600 }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new EnvironmentPauseError({ operation: "persist", reason: "unavailable", cause }),
          ),
        );
        yield* Ref.set(state, next);
        return next;
      }),
    );
  return EnvironmentPauseStore.of({
    get: Ref.get(state),
    update,
    recordDelivery: Effect.fn("EnvironmentPauseStore.recordDelivery")(
      (messageId, delivered, options) =>
        update((session) => {
          if (
            session === null ||
            (options?.onlyIfSuperseded && !environmentPauseDeliveryCancelled(session, messageId))
          )
            return session;
          let changed = false;
          const targets = session.targets.map((target) => {
            for (const direction of ["pause", "resume"] as const) {
              const renewPause =
                direction === "pause" &&
                delivered === "cancelled" &&
                options?.superseded === true &&
                session.phase !== "resuming";
              // A newer intent can reuse the id and phase. Retire only the
              // target snapshot whose non-delivery was observed.
              if (
                deliveryIdentity(session, target, direction).messageId !== messageId ||
                (options?.onlyIfSuperseded && target !== options.onlyIfSuperseded) ||
                target[direction] === "sent" ||
                (target[direction] === "unavailable" && !(renewPause && target.pauseCancelled))
              )
                continue;
              changed = true;
              return {
                ...target,
                [direction]: renewPause
                  ? ("pending" as const)
                  : delivered === "cancelled"
                    ? ("unavailable" as const)
                    : delivered
                      ? ("sent" as const)
                      : ("failed" as const),
                [`${direction}Accepted`]: !renewPause,
                ...(renewPause ? { pauseAttempt: target.pauseAttempt + 1 } : {}),
                ...(direction === "pause" && (delivered === true || delivered === "cancelled")
                  ? { rePause: undefined }
                  : {}),
                ...(direction === "resume" && delivered === true
                  ? { resumeRequired: undefined, resumeCancelled: undefined }
                  : {}),
                ...(direction === "resume" && delivered === "cancelled"
                  ? {
                      resumeCancelled: true as const,
                      ...(target.pause === "sent" ? { resumeRequired: true as const } : {}),
                    }
                  : {}),
                ...(direction === "pause" && delivered === "cancelled"
                  ? { pauseCancelled: renewPause ? undefined : (true as const) }
                  : {}),
                error: delivered
                  ? null
                  : "The provider did not accept this message. Retry to send it again.",
              };
            }
            return target;
          });
          return changed ? { ...session, targets } : session;
        }).pipe(Effect.asVoid),
    ),
  });
});

export const layer = Layer.effect(EnvironmentPauseStore, make);
