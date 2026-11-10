import {
  AuthOrchestrationReadScope,
  type ComposerContextRecord,
  type EnvironmentId,
} from "@t3tools/contracts";
import { threadContextsUnavailableForDestination } from "@t3tools/shared/composerContextReferences";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { readEnvironmentScope } from "../state/session";

export function readUnavailableThreadReference(
  text: string,
  records: ReadonlyArray<ComposerContextRecord>,
  destinationEnvironmentId: EnvironmentId,
) {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  const environments = new Map(
    [...presentations].map(([id, presentation]) => [
      id,
      {
        connected: presentation.connection.phase === "connected",
        canRead: readEnvironmentScope(id, AuthOrchestrationReadScope),
        supportsUniversalThreadReferences:
          presentation.serverConfig?.environment.capabilities.universalThreadReferences === true,
      },
    ]),
  );
  return threadContextsUnavailableForDestination({
    text,
    records,
    destinationEnvironmentId,
    environments,
  })[0];
}
