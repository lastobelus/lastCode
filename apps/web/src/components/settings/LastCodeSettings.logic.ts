import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { formatLocalEnvironmentLabel } from "../../environmentIcons";

export interface LastCodeEnvironmentSettingEntry {
  readonly environmentId: EnvironmentId;
  readonly kind: "local" | "remote";
  readonly label: string;
}

export function deriveLastCodeEnvironmentSettingEntries(input: {
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): LastCodeEnvironmentSettingEntry[] {
  const primaryEntry =
    input.primaryEnvironmentId === null ? undefined : input.entries.get(input.primaryEnvironmentId);
  const local =
    input.primaryEnvironmentId === null
      ? []
      : [
          {
            environmentId: input.primaryEnvironmentId,
            kind: "local" as const,
            label: formatLocalEnvironmentLabel(primaryEntry?.target.label),
          },
        ];
  const remotes = [...input.entries.entries()].flatMap(
    ([environmentId, entry]): LastCodeEnvironmentSettingEntry[] => {
      if (
        environmentId === input.primaryEnvironmentId ||
        entry.target._tag === "PrimaryConnectionTarget" ||
        isDesktopLocalConnectionTarget(entry.target)
      ) {
        return [];
      }
      return [{ environmentId, kind: "remote", label: entry.target.label }];
    },
  );
  return [...local, ...remotes];
}
