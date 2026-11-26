import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState, type ReactNode } from "react";
import type { AppBarAction } from "../../../components/ui/AppBar.types";
import { ThreadTagEditor } from "./TagSheet";
import { useTagPreferences } from "./state";

export function useThreadTagHeader(target: {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly hasThread?: boolean;
}) {
  const gt = useGT();
  const { header } = useTagPreferences();
  const enabled = header && target.hasThread !== false;
  const [open, setOpen] = useState(false);
  const action: AppBarAction | null = enabled
    ? { accessibilityLabel: gt("Thread tags"), icon: "tag", onPress: () => setOpen(true) }
    : null;
  return {
    action,
    render: (bar: ReactNode) => (
      <>
        {bar}
        {enabled && open ? (
          <ThreadTagEditor
            environmentId={EnvironmentId.make(target.environmentId)}
            threadId={ThreadId.make(target.threadId)}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    ),
  };
}
