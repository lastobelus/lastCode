import type { ReactNode } from "react";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarProviderBadgePreferences } from "./SidebarEnvironmentIcon";
import type { LastCodeThreadIdentity } from "./useLastCodeThreadIdentity";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";
import type { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import { LastCodeThreadArchiveControl } from "./LastCodeThreadArchiveControl";
import {
  LastCodeThreadMetadata,
  LastCodeThreadMetadataEnvironment,
} from "./LastCodeThreadMetadata";

interface Props {
  thread: SidebarThreadSummary;
  identity: LastCodeThreadIdentity;
  preferences: SidebarProviderBadgePreferences;
  jumpLabel: string | null;
  highlighted: boolean;
  archive: {
    allowed: boolean;
    confirmationRequested: boolean;
    editing: LastCodeThreadEditingCapabilities;
  };
  annotationHandle: ReturnType<typeof useLastCodeThreadDetails>["annotationPopoverHandle"];
  children: ReactNode;
}
/** Keep the environment/archive/timestamp tracks together, after the existing process controls. */
export function LastCodeThreadMetadataControls({
  thread,
  identity,
  preferences,
  jumpLabel,
  highlighted,
  archive,
  annotationHandle,
  children,
}: Props) {
  const confirming = archive.allowed && archive.confirmationRequested;
  return (
    <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
      {children}
      <LastCodeThreadMetadata
        thread={thread}
        jumpLabel={jumpLabel}
        highlighted={highlighted}
        confirming={confirming}
        canArchive={archive.allowed}
        annotationHandle={annotationHandle}
        environmentIcon={
          <LastCodeThreadMetadataEnvironment
            thread={thread}
            visible={identity.showsThreadEnvironmentIcon}
            label={identity.threadEnvironmentLabel}
            color={identity.environmentIconColor}
            confirming={confirming}
            providerEntry={identity.providerEntry}
            preferences={preferences}
          />
        }
      >
        {archive.allowed ? (
          <LastCodeThreadArchiveControl
            thread={thread}
            confirming={confirming}
            editing={archive.editing}
          />
        ) : null}
      </LastCodeThreadMetadata>
    </div>
  );
}
