/** LastCode identities are append-only and independent of upstream numbering. */
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";

import Migration0048 from "./Migrations/048_ProjectionThreadAnnotation.ts";
import Migration0049 from "./Migrations/049_UpdateDrain.ts";
import Migration0050 from "./Migrations/050_UpdateDrainClaim.ts";
import Migration0051 from "./Migrations/051_ProjectionTurnRequestCorrelations.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadWorktreeCleanup.ts";
import Migration0053 from "./Migrations/053_ProjectionThreadLinkedPullRequest.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsUnsettledAt.ts";
import Migration0055 from "./Migrations/055_ProjectionThreadMessageSource.ts";
import Migration0056 from "./Migrations/056_ProjectionThreadsPersistent.ts";
import Migration0057 from "./Migrations/057_ProjectionThreadAttention.ts";

export const lastcodeMigrationEntries = [
  [1, "ProjectionThreadAnnotation", Migration0048],
  [2, "UpdateDrain", Migration0049],
  [3, "UpdateDrainClaim", Migration0050],
  [4, "ProjectionTurnRequestCorrelations", Migration0051],
  [5, "ProjectionThreadWorktreeCleanup", Migration0052],
  [6, "ProjectionThreadLinkedPullRequest", Migration0053],
  [7, "ProjectionThreadsUnsettledAt", Migration0054],
  [8, "ProjectionThreadMessageSource", Migration0055],
  [9, "ProjectionThreadsPersistent", Migration0056],
  [10, "ProjectionThreadAttention", Migration0057],
] as const;

export const lastcodeMigrationManifest = lastcodeMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);
const run = Migrator.make({});
export const runLastCodeMigrations = Effect.fn("runLastCodeMigrations")(function* ({
  toMigrationInclusive,
}: { readonly toMigrationInclusive?: number } = {}) {
  return yield* run({
    table: "lastcode_sql_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(
        lastcodeMigrationEntries
          .filter(([id]) => toMigrationInclusive === undefined || id <= toMigrationInclusive)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
