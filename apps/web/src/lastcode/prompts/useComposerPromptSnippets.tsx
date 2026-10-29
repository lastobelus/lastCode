import type {
  EnvironmentId,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";
import { useRef, useState } from "react";
import { ComposerControl } from "~/components/chat/ComposerControl";
import { useStableCallback } from "~/hooks/useStableCallback";
import { PromptSnippetsDialog, type PromptSnippetsMode } from "./PromptSnippetsDialog";

export function useComposerPromptSnippets(input: {
  readonly environmentId: EnvironmentId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly target: string;
  readonly available: boolean;
  readonly disabled: boolean;
  readonly readSnapshot: () => { value: string; expandedCursor: number };
  readonly insert: (start: number, end: number, text: string) => boolean;
  readonly focusAt: (cursor: number) => void;
}) {
  const [session, setSession] = useState<{
    target: string;
    cursor: number;
    mode: PromptSnippetsMode;
  } | null>(null);
  const returnCursor = useRef(0);
  const open = useStableCallback((mode: PromptSnippetsMode) => {
    if (!input.available || input.disabled) return;
    const cursor = input.readSnapshot().expandedCursor;
    returnCursor.current = cursor;
    setSession({ target: input.target, cursor, mode });
  });
  const openControl = useStableCallback((command: KeybindingCommand) => {
    if (command !== "composer.promptSnippets" && command !== "composer.editPromptSnippets")
      return false;
    open(command === "composer.editPromptSnippets" ? "edit" : "pick");
    return true;
  });
  return {
    openControl,
    trigger: input.available ? (
      <div className="me-2 shrink-0">
        <ComposerControl
          data-composer-shortcut="composer.promptSnippets"
          aria-label="Common prompts"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => open("pick")}
          disabled={input.disabled}
        >
          <MessageSquareTextIcon aria-hidden="true" className="size-4" />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            Prompts
          </span>
        </ComposerControl>
      </div>
    ) : null,
    dialog:
      session?.target === input.target ? (
        <PromptSnippetsDialog
          key={input.target}
          environmentId={input.environmentId}
          keybindings={input.keybindings}
          initialMode={session.mode}
          onClose={() => setSession(null)}
          onInsert={(text) => {
            if (!input.available || input.disabled) return false;
            const snapshot = input.readSnapshot();
            const cursor = Math.min(session.cursor, snapshot.value.length);
            const insertion = `${cursor > 0 && !/\s/u.test(snapshot.value[cursor - 1] ?? "") ? " " : ""}${text}\n`;
            const inserted = input.insert(cursor, cursor, insertion);
            if (inserted) returnCursor.current = cursor + insertion.length;
            return inserted;
          }}
          onReturnFocus={() => input.focusAt(returnCursor.current)}
        />
      ) : null,
  };
}
