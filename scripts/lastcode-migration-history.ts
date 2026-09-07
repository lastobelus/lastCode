// @effect-diagnostics nodeBuiltinImport:off -- Release gates inspect immutable Git objects without loading candidate code.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const UPSTREAM_REGISTRY = "apps/server/src/persistence/Migrations.ts";
const LASTCODE_REGISTRY = "apps/server/src/persistence/LastCodeMigrations.ts";

export interface MigrationIdentity {
  readonly id: number;
  readonly name: string;
  readonly implementation: string;
}

/** Release validation deliberately accepts only the literal registry format.
 * Executing candidate code here would let a broken replay validate itself. */
export function readMigrationIdentities(
  source: string,
  exportName: string,
): ReadonlyArray<MigrationIdentity> {
  const body = new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const;`, "u").exec(
    source,
  )?.[1];
  if (body === undefined) throw new Error(`Missing literal migration registry ${exportName}.`);
  const imports = new Map(
    Array.from(
      source.matchAll(/import (\w+) from "(\.[^"]+)";/gu),
      (match) => [match[1]!, match[2]!] as const,
    ),
  );
  const identities: Array<MigrationIdentity> = [];
  let remaining = body.trim();
  while (remaining.length > 0) {
    const match = /^\[(\d+),\s*"([^"]+)",\s*(\w+)\],?\s*/u.exec(remaining);
    if (!match) throw new Error(`Unsupported entry in ${exportName}: ${remaining.slice(0, 80)}`);
    const implementation = imports.get(match[3]!);
    if (!implementation) throw new Error(`Migration ${match[3]} has no local default import.`);
    identities.push({ id: Number(match[1]), name: match[2]!, implementation });
    remaining = remaining.slice(match[0].length);
  }
  if (identities.length === 0) throw new Error(`Migration registry ${exportName} is empty.`);
  let previousId = 0;
  const names = new Set<string>();
  for (const entry of identities) {
    if (!Number.isSafeInteger(entry.id) || entry.id <= previousId || names.has(entry.name)) {
      throw new Error(`Duplicate or unordered migration identity ${entry.id}_${entry.name}.`);
    }
    previousId = entry.id;
    names.add(entry.name);
  }
  return identities;
}

export function assertAppendOnlyMigrations(
  previous: ReadonlyArray<MigrationIdentity>,
  candidate: ReadonlyArray<MigrationIdentity>,
): void {
  for (const [index, entry] of previous.entries()) {
    const next = candidate[index];
    if (next?.id !== entry.id || next.name !== entry.name) {
      throw new Error(
        `LastCode migration ${entry.id}_${entry.name} was removed, reordered, or reassigned. ` +
          "Preserve shipped identities and append a new migration instead.",
      );
    }
  }
  const previousMaximum = previous.at(-1)?.id ?? 0;
  if (candidate.slice(previous.length).some((entry) => entry.id <= previousMaximum)) {
    throw new Error("New LastCode migrations must follow the last shipped migration ID.");
  }
}

function git(repoRoot: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasFile(repoRoot: string, ref: string, path: string): boolean {
  return (
    NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${ref}:${path}`], {
      cwd: repoRoot,
      stdio: "ignore",
    }).status === 0
  );
}

function migrationPath(registry: string, implementation: string): string {
  const resolved = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(registry), implementation),
  );
  if (!resolved.startsWith("apps/server/src/persistence/") || !resolved.endsWith(".ts")) {
    throw new Error(`Migration implementation escapes persistence source: ${implementation}`);
  }
  return resolved;
}

export function assertMigrationHistory(input: {
  readonly repoRoot: string;
  readonly candidateRef: string;
  readonly upstreamRef: string;
  readonly previousRef?: string;
}): void {
  const { repoRoot } = input;
  // Resolve refs once so a concurrently advancing branch cannot mix two trees.
  const candidate = git(repoRoot, ["rev-parse", `${input.candidateRef}^{commit}`]).trim();
  const upstream = git(repoRoot, ["rev-parse", `${input.upstreamRef}^{commit}`]).trim();
  const read = (ref: string, path: string) => git(repoRoot, ["show", `${ref}:${path}`]);
  const upstreamSource = read(upstream, UPSTREAM_REGISTRY);
  if (read(candidate, UPSTREAM_REGISTRY) !== upstreamSource) {
    throw new Error(
      "Checkpoint changed the upstream migration registry. Keep LastCode migrations in their own ledger.",
    );
  }
  for (const entry of readMigrationIdentities(upstreamSource, "migrationEntries")) {
    const path = migrationPath(UPSTREAM_REGISTRY, entry.implementation);
    if (read(candidate, path) !== read(upstream, path)) {
      throw new Error(`Checkpoint changed upstream migration ${entry.id}_${entry.name}: ${path}`);
    }
  }
  const next = readMigrationIdentities(
    read(candidate, LASTCODE_REGISTRY),
    "lastcodeMigrationEntries",
  );
  for (const entry of next) read(candidate, migrationPath(LASTCODE_REGISTRY, entry.implementation));
  for (const required of ["DatabaseMigrations.ts", "DatabaseMigrations.test.ts"]) {
    if (!hasFile(repoRoot, candidate, `apps/server/src/persistence/${required}`)) {
      throw new Error(
        `Checkpoint lost required migration conversion or upgrade tests: ${required}`,
      );
    }
  }
  if (!input.previousRef) return;
  const previous = git(repoRoot, ["rev-parse", `${input.previousRef}^{commit}`]).trim();
  // The initial split adopts a legacy combined history. Subsequent checkpoints
  // must retain the independently versioned LastCode history from that release.
  if (!hasFile(repoRoot, previous, LASTCODE_REGISTRY)) return;
  const prior = readMigrationIdentities(
    read(previous, LASTCODE_REGISTRY),
    "lastcodeMigrationEntries",
  );
  assertAppendOnlyMigrations(prior, next);
  for (const [index, entry] of prior.entries()) {
    const oldPath = migrationPath(LASTCODE_REGISTRY, entry.implementation);
    const newPath = migrationPath(LASTCODE_REGISTRY, next[index]!.implementation);
    if (read(previous, oldPath) !== read(candidate, newPath)) {
      throw new Error(
        `LastCode migration ${entry.id}_${entry.name} changed after release. Append a repair migration instead.`,
      );
    }
  }
}
