import { useMemo } from "react";
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
  const localEnvByUrl = useMemo(() => {
    const map = new Map<string, ConnectionStatus>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  }, [environments]);
  const { connecting, failed } = classifyLastCodeSecondaryConnections(secondaries, localEnvByUrl);
  if (connecting.length === 0 && failed.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      {connecting.length > 0 ? (
        <Alert variant="sidebar">
          <Spinner />
          <AlertTitle>Connecting {connecting.join(", ")}</AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}
