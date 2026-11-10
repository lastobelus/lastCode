import {
  downloadLastCodeSidebarUpdate,
  installLastCodeSidebarUpdate,
} from "./lastcodeSidebarDesktopOperations";
import { useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import {
  getArm64IntelBuildWarningDescription,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
} from "../desktopUpdate.logic";
import { SidebarGroup } from "../ui/sidebar";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

function useLastCodeSidebarUpdateAction() {
  const desktopUpdateState = useDesktopUpdateState();
  const [desktopUpdateActionPending, setDesktopUpdateActionPending] = useState(false);
  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const handleDesktopUpdateButtonClick = () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateActionPending) return;
    if (desktopUpdateButtonAction === "none") return;
    setDesktopUpdateActionPending(true);
    if (desktopUpdateButtonAction === "download") {
      downloadLastCodeSidebarUpdate(bridge, setDesktopUpdateActionPending);
      return;
    }
    void installLastCodeSidebarUpdate(bridge, desktopUpdateState, setDesktopUpdateActionPending);
  };
  return {
    desktopUpdateState,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled: desktopUpdateButtonDisabled || desktopUpdateActionPending,
    handleDesktopUpdateButtonClick,
  };
}
export function LastCodeSidebarDesktopNotice() {
  const {
    desktopUpdateState,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    handleDesktopUpdateButtonClick,
  } = useLastCodeSidebarUpdateAction();
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  return (
    <>
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
    </>
  );
}
