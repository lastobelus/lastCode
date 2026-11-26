import { T, Var } from "gt-react";
import { TriangleAlertIcon } from "lucide-react";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import { useEnvironments } from "../../state/environments";
import { SidebarGroup } from "../ui/sidebar";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Spinner } from "../ui/spinner";

import {
  classifyLastCodeSecondaryConnections,
  type ConnectionStatus,
} from "./lastcodeSidebarConnections.logic";
export function LastCodeSidebarConnectionNotice() {
  const { environments } = useEnvironments();
  // The desktop bootstrap hook polls because the bridge has no change event.
  // Cold bootstraps have no URL yet and remain Connecting until the catalog catches up.
  const secondaries = useDesktopLocalBootstraps();
  const localEnvByUrl = new Map<string, ConnectionStatus>();
  for (const environment of environments) {
    if (
      isDesktopLocalConnectionTarget(environment.entry.target) &&
      environment.displayUrl !== null
    ) {
      localEnvByUrl.set(environment.displayUrl, {
        phase: environment.connection.phase,
        error: environment.connection.error,
      });
    }
  }

  const { connecting, failed } = classifyLastCodeSecondaryConnections(secondaries, localEnvByUrl);
  if (connecting.length === 0 && failed.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      {connecting.length > 0 ? (
        <Alert variant="sidebar">
          <Spinner />
          <AlertTitle>
            <T>
              Connecting <Var>{connecting.join(", ")}</Var>
            </T>
          </AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>
            <T>
              Couldn't connect <Var>{failed.map((entry) => entry.label).join(", ")}</Var>
            </T>
          </AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || <T>The backend didn't respond.</T>}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}
