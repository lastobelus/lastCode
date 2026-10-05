import { configuredPreviewEnvironmentUrl } from "@t3tools/client-runtime/preview-hosting";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentCatalog } from "../connection/catalog";
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("mobile-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function useConfiguredPreviewEnvironmentUrl(
  environmentId: EnvironmentId,
  connection: PreparedConnection | null,
) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return connection === null
    ? null
    : configuredPreviewEnvironmentUrl(connection, catalog.entries.get(environmentId));
}
