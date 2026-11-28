import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  readDesktopInstallOutcome,
  recordReplacementBackend,
  type DesktopInstallOutcome,
} from "../../../../scripts/lastcode-install-outcome.mjs";
import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "lastcode-local-install-outcome",
);

class LocalInstallOutcomeError extends Schema.TaggedError<
  LocalInstallOutcomeError,
  { readonly brand: unique symbol }
>()("LocalInstallOutcomeError", { cause: Schema.Defect() }) {}

export const readLocalInstallOutcome = (environment: DesktopEnvironment["Service"]) => {
  if (environment.platform !== "darwin" || !environment.isPackaged) return Effect.succeed(null);
  const { path } = environment;
  return Effect.try({
    try: () =>
      readDesktopInstallOutcome(
        path.join(environment.homeDirectory, ".lastcode", "local-updates"),
        path.resolve(environment.resourcesPath, "../.."),
        environment.appVersion,
        path.resolve(environment.stateDir),
      ),
    catch: (cause) => new LocalInstallOutcomeError({ cause }),
  }).pipe(
    Effect.tap((outcome) =>
      outcome === null
        ? Effect.void
        : logInfo("read local installer outcome", {
            status: outcome.status,
            targetVersion: outcome.record.version,
            matchesReplacement: outcome.matchesReplacement,
          }),
    ),
    Effect.catch((error) =>
      logWarning("could not read the local installer outcome", { error }).pipe(Effect.as(null)),
    ),
  );
};

export const recordLocalInstallBackend = (
  outcome: DesktopInstallOutcome | null,
  ready: boolean,
) => {
  if (!outcome?.matchesReplacement) return Effect.void;
  return Effect.tryPromise({
    try: () => recordReplacementBackend(outcome, ready),
    catch: (cause) => new LocalInstallOutcomeError({ cause }),
  }).pipe(
    Effect.catch((error) => logWarning("could not update the local installer outcome", { error })),
  );
};
