import type {
  EnvironmentId,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";
import { promptSnippetWordAtCursor } from "@t3tools/shared/promptSnippetSearch";
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
    value: string;
    word: ReturnType<typeof promptSnippetWordAtCursor>;
    mode: PromptSnippetsMode;
  } | null>(null);
  const returnCursor = useRef(0);
  const open = useStableCallback((mode: PromptSnippetsMode) => {
    if (!input.available || input.disabled) return;
    const { value, expandedCursor: cursor } = input.readSnapshot();
    returnCursor.current = cursor;
    setSession({
      target: input.target,
      cursor,
      value,
      word: promptSnippetWordAtCursor(value, cursor),
      mode,
    });
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
          initialQuery={session.word?.query ?? ""}
          onClose={() => setSession(null)}
          onInsert={(text) => {
            if (!input.available || input.disabled) return false;
            const snapshot = input.readSnapshot();
            const cursor = Math.min(session.cursor, snapshot.value.length);
            const word = snapshot.value === session.value ? session.word : null;
            const start = word?.start ?? cursor;
            const end = word?.end ?? cursor;
            const insertion = word
              ? text
              : `${start > 0 && !/\s/u.test(snapshot.value[start - 1] ?? "") ? " " : ""}${text}\n`;
            const inserted = input.insert(start, end, insertion);
            if (inserted) returnCursor.current = start + insertion.length;
            return inserted;
          }}
          onReturnFocus={() => input.focusAt(returnCursor.current)}
        />
      ) : null,
  };
}
