import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PromptSnippet, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { searchPromptSnippets } from "@t3tools/shared/promptSnippetSearch";
import { MessageSquareTextIcon } from "lucide-react";
import { useState } from "react";

import { promptSnippetsEnvironment } from "../../state/promptSnippets";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { CommandPaletteContent } from "../CommandPaletteContent";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "../ui/command";

export function PromptSnippetsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onClose: () => void;
  readonly onInsert: (text: string) => boolean;
  readonly onReturnFocus: () => void;
}) {
  const library = useEnvironmentQuery(
    promptSnippetsEnvironment.list({ environmentId: props.environmentId, input: {} }),
  );
  const recordUse = useAtomCommand(promptSnippetsEnvironment.recordUse, { reportFailure: false });
  const discover = useAtomCommand(promptSnippetsEnvironment.discover);
  const dismiss = useAtomCommand(promptSnippetsEnvironment.dismiss);
  const canDismiss = useAtomValue(
    promptSnippetsEnvironment.dismiss.permissionAtom(props.environmentId),
  );
  const canDiscover = useAtomValue(
    promptSnippetsEnvironment.discover.permissionAtom(props.environmentId),
  );
  const canLearn = useAtomValue(
    promptSnippetsEnvironment.recordUse.permissionAtom(props.environmentId),
  );
  const [refreshing, setRefreshing] = useState(false);
  return (
    <PromptSnippetsPicker
      {...props}
      snippets={library.data?.snippets ?? []}
      loading={library.isPending}
      discovering={refreshing || library.data?.discovering === true}
      error={library.error ?? library.data?.lastError ?? null}
      onDiscover={
        canDiscover
          ? () => {
              setRefreshing(true);
              void discover({ environmentId: props.environmentId, input: {} }).finally(() =>
                setRefreshing(false),
              );
            }
          : undefined
      }
      onDismiss={
        canDismiss
          ? (snippet) => {
              void dismiss({
                environmentId: props.environmentId,
                input: { snippetId: snippet.id },
              });
            }
          : undefined
      }
      onSelect={(snippet, query) => {
        if (!props.onInsert(snippet.text)) return;
        props.onClose();
        if (canLearn)
          void recordUse({
            environmentId: props.environmentId,
            input: { snippetId: snippet.id, query },
          });
      }}
    />
  );
}

export function PromptSnippetsPicker(props: {
  readonly snippets: ReadonlyArray<PromptSnippet>;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly loading: boolean;
  readonly discovering: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSelect: (snippet: PromptSnippet, query: string) => void;
  readonly onDiscover?: (() => void) | undefined;
  readonly onDismiss?: ((snippet: PromptSnippet) => void) | undefined;
  readonly onReturnFocus: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const results = searchPromptSnippets(props.snippets, query);
  const selected = results.find((snippet) => snippet.id === highlighted) ?? results[0];
  const items: CommandPaletteActionItem[] = results.map((snippet) => ({
    kind: "action",
    value: snippet.id,
    title: snippet.title,
    description: <span className="line-clamp-2 whitespace-pre-wrap">{snippet.text}</span>,
    searchTerms: [],
    icon: <MessageSquareTextIcon className="size-4" />,
    run: async () => props.onSelect(snippet, query),
  }));
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <CommandDialogPopup
        aria-label="Common prompts"
        data-prompt-snippets="true"
        className="overflow-hidden"
        finalFocus={() => {
          props.onReturnFocus();
          return false;
        }}
        onBackdropPointerDown={props.onClose}
      >
        <CommandPaletteContent
          aria-label="Common prompts"
          inputProps={{
            placeholder: "Search common prompts…",
            "aria-label": "Search common prompts",
          }}
          value={query}
          mode="none"
          onValueChange={(value) => {
            setQuery(value);
            setHighlighted(null);
          }}
          onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
          footerActionLabel="Insert prompt"
          footerTrailing={
            <div className="flex items-center gap-1">
              {selected && props.onDismiss ? (
                <CommandFooterAction onClick={() => props.onDismiss?.(selected)}>
                  Dismiss prompt
                </CommandFooterAction>
              ) : null}
              {props.onDiscover ? (
                <CommandFooterAction disabled={props.discovering} onClick={props.onDiscover}>
                  {props.discovering ? "Finding prompts…" : "Find new prompts"}
                </CommandFooterAction>
              ) : null}
            </div>
          }
          testId="prompt-snippets-picker"
        >
          {props.error ? (
            <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
              {props.error}
            </p>
          ) : null}
          <CommandPaletteResults
            groups={
              items.length > 0 ? [{ value: "common-prompts", label: "Common prompts", items }] : []
            }
            highlightedItemValue={highlighted}
            isActionsOnly
            keybindings={props.keybindings}
            onExecuteItem={(item) => {
              if (item.kind === "action") void item.run();
            }}
            emptyStateMessage={
              props.loading
                ? "Loading common prompts…"
                : props.discovering
                  ? "Finding common prompts in your conversations…"
                  : query.trim()
                    ? "No matching prompts."
                    : "No common prompts yet. They're found in your conversations once a day."
            }
          />
          {selected ? (
            <div className="border-t border-border/50 px-4 py-3">
              <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                {selected.text}
              </p>
            </div>
          ) : null}
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
