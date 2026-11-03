import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import type { AppBarAction } from "../../../components/ui/AppBar.types";
import { ThreadTagEditor } from "./TagSheet";
import { useTagPreferences } from "./state";

export function useThreadTagHeader(target: {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
}) {
  const { header: enabled } = useTagPreferences();
  const [open, setOpen] = useState(false);
  const action: AppBarAction | null = enabled
    ? { accessibilityLabel: "Thread tags", icon: "tag", onPress: () => setOpen(true) }
    : null;
  return {
    action,
    editor: enabled && open ? (
      <ThreadTagEditor
        environmentId={EnvironmentId.make(target.environmentId)}
        threadId={ThreadId.make(target.threadId)}
        onClose={() => setOpen(false)}
      />
    ) : null,
  };
}
