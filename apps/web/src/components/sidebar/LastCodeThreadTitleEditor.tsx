import { useCallback, useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { renameLastCodeThread } from "./lastcodeThreadRename";
import { useSidebarModeStore } from "../../sidebarMode";
import type {
  LastCodeRenameTarget,
  LastCodeThreadEditingCapabilities,
} from "./useLastCodeThreadEditing";

export function LastCodeThreadTitleEditor({
  threadRef,
  title,
  target,
  finishRename,
}: {
  threadRef: ScopedThreadRef;
  title: string;
  target: LastCodeRenameTarget;
  finishRename: LastCodeThreadEditingCapabilities["finishRename"];
}) {
  const [draft, setDraft] = useState(target.initialTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committed = useRef(false);
  const update = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setInput = useCallback((element: HTMLInputElement | null) => {
    if (!element) return;
    if (inputRef.current !== element) {
      inputRef.current = element;
      element.focus();
      element.select();
    } else if (document.activeElement === document.body) {
      element.focus();
    }
  }, []);
  const finish = () => finishRename(threadRef, target.session);
  const submit = () => {
    if (committed.current) return;
    committed.current = true;
    void renameLastCodeThread(threadRef, draft, title, { update, finish });
  };
  return (
    <input
      data-lastcode-title-editor=""
      ref={setInput}
      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
      // Reserve the leading column's physical width so controls wrap above the editor.
      style={{ minWidth: "calc(72px * var(--lastcode-sidebar-content-zoom))" }}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          committed.current = true;
          finish();
        }
      }}
      onBlur={() => {
        if (!useSidebarModeStore.getState().lastcodeHidden) submit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
