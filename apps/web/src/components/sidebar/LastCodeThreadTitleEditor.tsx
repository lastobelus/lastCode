import { useCallback, useRef, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { renameLastCodeThread } from "./lastcodeThreadRename";
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
    if (element && inputRef.current !== element) {
      inputRef.current = element;
      element.focus();
      element.select();
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
      ref={setInput}
      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
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
      onBlur={submit}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
