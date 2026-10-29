import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PromptSnippet, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { searchPromptSnippets } from "@t3tools/shared/promptSnippetSearch";
import { MessageSquareTextIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { toastManager } from "~/components/ui/toast";

import { promptSnippetsEnvironment } from "~/state/promptSnippets";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useStableCallback } from "~/hooks/useStableCallback";
import { CommandPaletteContent } from "~/components/CommandPaletteContent";
import type { CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { CommandPaletteResults } from "~/components/CommandPaletteResults";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "~/components/ui/command";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "~/components/ui/alert-dialog";
import { PromptSnippetFields } from "./PromptSnippetFields";

export type PromptSnippetsMode = "pick" | "edit";

export function PromptSnippetsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly initialMode?: PromptSnippetsMode;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onClose: () => void;
  readonly onInsert: (text: string) => boolean;
  readonly onReturnFocus: () => void;
}) {
  const library = useEnvironmentQuery(
    promptSnippetsEnvironment.list({ environmentId: props.environmentId, input: {} }),
  );
  const save = useAtomCommand(promptSnippetsEnvironment.save);
  const canSave = useAtomValue(promptSnippetsEnvironment.save.permissionAtom(props.environmentId));
  const recordUse = useAtomCommand(promptSnippetsEnvironment.recordUse, { reportFailure: false });
  const discover = useAtomCommand(promptSnippetsEnvironment.discover);
  const dismiss = useAtomCommand(promptSnippetsEnvironment.dismiss);
  const restore = useAtomCommand(promptSnippetsEnvironment.restore);
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
      onSave={
        canSave
          ? async (input) => {
              const result = await save({ environmentId: props.environmentId, input });
              return AsyncResult.isSuccess(result) ? result.value : null;
            }
          : undefined
      }
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
              return dismiss({
                environmentId: props.environmentId,
                input: { snippetId: snippet.id },
              }).then((result) => {
                if (!AsyncResult.isSuccess(result)) return false;
                const id = toastManager.add({
                  type: "info",
                  title: "Prompt dismissed",
                  actionProps: {
                    children: "Undo",
                    onClick: () => {
                      void restore({
                        environmentId: props.environmentId,
                        input: { snippetId: snippet.id },
                      }).then((restored) => {
                        if (AsyncResult.isSuccess(restored)) toastManager.close(id);
                      });
                    },
                  },
                });
                return true;
              });
            }
          : undefined
      }
      onSelect={(snippet, query) => {
        if (!props.onInsert(snippet.text)) return false;
        props.onClose();
        if (canLearn)
          void recordUse({
            environmentId: props.environmentId,
            input: { snippetId: snippet.id, query },
          });
        return true;
      }}
    />
  );
}

type Draft = { title: string; text: string; savedTitle: string; savedText: string };

export function PromptSnippetsPicker(props: {
  readonly snippets: ReadonlyArray<PromptSnippet>;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly loading: boolean;
  readonly discovering: boolean;
  readonly error: string | null;
  readonly initialMode?: PromptSnippetsMode;
  readonly onClose: () => void;
  readonly onSelect: (snippet: PromptSnippet, query: string) => boolean | void;
  readonly onSave?:
    | ((input: {
        snippetId?: string;
        title: string;
        text: string;
      }) => Promise<PromptSnippet | null>)
    | undefined;
  readonly onDiscover?: (() => void) | undefined;
  readonly onDismiss?: ((snippet: PromptSnippet) => Promise<boolean>) | undefined;
  readonly onReturnFocus: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PromptSnippetsMode>(props.initialMode ?? "pick");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [created, setCreated] = useState<PromptSnippet[]>([]);
  const [saving, setSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const returnFocusOnCloseRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the picker's scroll viewport aligned with its selection when returning from the wider editor.
  useLayoutEffect(() => {
    if (mode !== "pick" || selectedId === null) return;
    contentRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [mode, selectedId]);
  const snippets = [
    ...props.snippets.map((snippet) => {
      const saved = created.find((entry) => entry.id === snippet.id);
      return saved
        ? { ...snippet, title: saved.title, text: saved.text, userEdited: true as const }
        : snippet;
    }),
    ...created.filter((entry) => !props.snippets.some((saved) => saved.id === entry.id)),
  ];
  const results = searchPromptSnippets(snippets, query);
  const selected = snippets.find((snippet) => snippet.id === selectedId) ?? results[0];
  const draft = selected ? drafts[selected.id] : undefined;
  const displayed =
    selected && draft ? { ...selected, title: draft.title, text: draft.text } : selected;
  const hasChanges =
    created.some((entry) => entry.id === "new") ||
    Object.values(drafts).some(
      (entry) => entry.title !== entry.savedTitle || entry.text !== entry.savedText,
    );
  const confirm = useStableCallback((action: () => void) => {
    if (hasChanges) setPendingAction(() => action);
    else action();
  });
  const close = useStableCallback(() => {
    if (!saving) confirm(props.onClose);
  });
  const selectSnippet = useStableCallback((snippet: PromptSnippet) => {
    confirm(() => {
      // Refocusing the old editor during close can overwrite an insertion still committing.
      returnFocusOnCloseRef.current = false;
      if (props.onSelect(snippet, query) === false) returnFocusOnCloseRef.current = true;
    });
  });
  const returnFocus = useStableCallback(() => {
    if (returnFocusOnCloseRef.current) props.onReturnFocus();
    return false as const;
  });
  const changeDraft = (field: "title" | "text", value: string) => {
    if (!selected) return;
    setDrafts((current) => ({
      ...current,
      [selected.id]: {
        ...(current[selected.id] ?? {
          title: selected.title,
          text: selected.text,
          savedTitle: selected.title,
          savedText: selected.text,
        }),
        [field]: value,
      },
    }));
  };
  const save = async () => {
    if (!displayed || !props.onSave || saving) return;
    setSaving(true);
    const result = await props
      .onSave({
        ...(displayed.id === "new" ? {} : { snippetId: displayed.id }),
        title: displayed.title,
        text: displayed.text,
      })
      .finally(() => setSaving(false));
    if (!result) return;
    setDrafts((current) => {
      const next = { ...current };
      delete next[displayed.id];
      next[result.id] = {
        title: result.title,
        text: result.text,
        savedTitle: result.title,
        savedText: result.text,
      };
      return next;
    });
    setCreated((current) => [
      ...current.filter((entry) => entry.id !== "new" && entry.id !== result.id),
      result,
    ]);
    setSelectedId(result.id);
  };
  const dismissSelected = async () => {
    if (!selected || saving) return;
    if (selected.id !== "new" && !(await props.onDismiss?.(selected))) return;
    setCreated((current) => current.filter((entry) => entry.id !== selected.id));
    setDrafts((current) => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    setSelectedId(null);
  };
  const items: CommandPaletteActionItem[] = results.map((snippet) => ({
    kind: "action",
    value: snippet.id,
    title:
      mode === "edit" ? (
        snippet.title || "New prompt"
      ) : (
        <span className="line-clamp-2 h-10 whitespace-pre-wrap">{snippet.text}</span>
      ),
    ...(mode === "edit"
      ? {
          description: <span className="line-clamp-2 h-8 whitespace-pre-wrap">{snippet.text}</span>,
        }
      : {}),
    searchTerms: [],
    icon: <MessageSquareTextIcon className="size-4" />,
    run: async () => (mode === "edit" ? setSelectedId(snippet.id) : selectSnippet(snippet)),
  }));
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <CommandDialogPopup
        aria-label={mode === "edit" ? "Edit common prompts" : "Common prompts"}
        data-prompt-snippets="true"
        data-prompt-snippets-mode={mode}
        className={
          mode === "edit"
            ? "h-[min(40rem,80dvh)] max-h-[80dvh] max-w-4xl overflow-hidden"
            : "max-h-[80dvh] overflow-hidden"
        }
        finalFocus={returnFocus}
        onBackdropPointerDown={close}
      >
        <div ref={contentRef} className="contents">
          <CommandPaletteContent
            aria-label="Common prompts"
            inputProps={{
              placeholder: "Search common prompts…",
              "aria-label": "Search common prompts",
              disabled: saving,
              onKeyDown: (event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                (
                  event as typeof event & { preventBaseUIHandler?: () => void }
                ).preventBaseUIHandler?.();
                event.preventDefault();
                event.stopPropagation();
                if (mode === "pick" && selected && !saving) selectSnippet(selected);
              },
            }}
            value={query}
            mode="none"
            panelSize="fill"
            highlightItemOnHover={mode === "pick"}
            onValueChange={(value) => {
              setQuery(value);
              if (mode === "pick") setSelectedId(null);
            }}
            onItemHighlighted={(value, details) => {
              if (
                saving ||
                (details.reason === "none" &&
                  selectedId !== null &&
                  results.some((entry) => entry.id === selectedId))
              )
                return;
              if (typeof value === "string" && (mode === "pick" || details.reason === "keyboard"))
                setSelectedId(value);
            }}
            footerActionLabel={mode === "pick" ? "Insert" : undefined}
            footerTrailing={
              <div className="flex items-center gap-1">
                {props.onDiscover ? (
                  <CommandFooterAction
                    disabled={props.discovering || saving}
                    onClick={props.onDiscover}
                  >
                    {props.discovering ? "Finding prompts…" : "Find new prompts"}
                  </CommandFooterAction>
                ) : null}
                <CommandFooterAction
                  disabled={saving || selected?.id === "new"}
                  onClick={(event) => {
                    setSelectedId(selected?.id ?? null);
                    if (
                      mode === "edit" &&
                      selected &&
                      !results.some((entry) => entry.id === selected.id)
                    )
                      setQuery("");
                    setMode(mode === "pick" ? "edit" : "pick");
                    event.currentTarget
                      .closest("[data-prompt-snippets]")
                      ?.querySelector("input")
                      ?.focus();
                  }}
                >
                  {mode === "pick" ? "Edit prompts" : "Search prompts"}
                </CommandFooterAction>
              </div>
            }
            testId="prompt-snippets-picker"
          >
            {props.error ? (
              <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
                {props.error}
              </p>
            ) : null}
            <div className={mode === "edit" ? "flex min-h-0 flex-1" : "flex min-h-0 flex-col"}>
              <div
                className={
                  mode === "edit"
                    ? "flex w-2/5 min-w-36 shrink-0 flex-col border-e border-border/50"
                    : "flex h-69 min-h-0 shrink-0 flex-col"
                }
                data-testid="prompt-snippets-list"
              >
                {mode === "edit" && props.onSave ? (
                  <div className="flex justify-end px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onClick={() => {
                        setCreated((current) =>
                          current.some((entry) => entry.id === "new")
                            ? current
                            : [
                                ...current,
                                {
                                  id: "new",
                                  title: "",
                                  text: "",
                                  useCount: 0,
                                  lastUsedAt: null,
                                  queryUses: [],
                                },
                              ],
                        );
                        setQuery("");
                        setSelectedId("new");
                      }}
                    >
                      New prompt
                    </Button>
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  <CommandPaletteResults
                    groups={items.length > 0 ? [{ value: "common-prompts", label: "", items }] : []}
                    highlightedItemValue={selected?.id ?? null}
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
                </div>
              </div>
              {mode === "edit" ? (
                displayed ? (
                  <PromptSnippetFields
                    snippet={displayed}
                    busy={saving}
                    writable={props.onSave !== undefined}
                    dirty={
                      selected?.id === "new" ||
                      (!!draft &&
                        (draft.title !== draft.savedTitle || draft.text !== draft.savedText))
                    }
                    onChange={changeDraft}
                    onSave={() => void save()}
                    onDismiss={
                      props.onDismiss || selected?.id === "new"
                        ? () => void dismissSelected()
                        : undefined
                    }
                  />
                ) : (
                  <p className="flex-1 p-5 text-sm text-muted-foreground">
                    Choose a prompt to edit.
                  </p>
                )
              ) : null}
            </div>
            {mode === "pick" && displayed ? (
              <div className="border-t border-border/50 px-4 py-3">
                <p className="max-h-20 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                  {displayed.text}
                </p>
              </div>
            ) : null}
          </CommandPaletteContent>
        </div>
      </CommandDialogPopup>
      {pendingAction ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingAction(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                Your unsaved prompt edits will be lost.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button type="button" variant="outline" onClick={() => setPendingAction(null)}>
                Keep editing
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  setDrafts({});
                  setCreated((current) => current.filter((entry) => entry.id !== "new"));
                  setPendingAction(null);
                  pendingAction?.();
                }}
              >
                Discard changes
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </CommandDialog>
  );
}
