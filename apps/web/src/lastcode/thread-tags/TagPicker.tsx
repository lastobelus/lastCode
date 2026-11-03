import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectId,
  ThreadTagVocabularyEntry,
  ThreadTagVocabularyInput,
} from "@t3tools/contracts";
import { ThreadTag } from "@t3tools/contracts";
import { rankThreadTagVocabulary } from "@t3tools/shared/threadTags";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useDeferredValue, useState } from "react";
import { CheckIcon, PlusIcon } from "lucide-react";
import { Command, CommandInput, CommandItem, CommandList } from "../../components/ui/command";
import { Button } from "../../components/ui/button";
import { tagVocabulary } from "./state";

const vocabularyPages = Atom.family((key: string) => {
  const target = JSON.parse(key) as {
    environmentIds: EnvironmentId[];
    projectId?: ProjectId;
    projectOnly: boolean;
    query: string;
    archived: boolean;
    cursor: number;
  };
  const input: ThreadTagVocabularyInput = {
    query: target.query,
    archived: target.archived,
    cursor: target.cursor,
    limit: 100,
    ...(target.projectId
      ? {
          preferredProjectId: target.projectId,
          ...(target.projectOnly ? { projectId: target.projectId } : {}),
        }
      : {}),
  };
  return Atom.make((get) => {
    const entries = new Map<string, ThreadTagVocabularyEntry>();
    let loading = false;
    let failed = false;
    let hasMore = false;
    for (const environmentId of target.environmentIds) {
      const result = get(tagVocabulary({ environmentId, input }));
      loading ||= result.waiting || AsyncResult.isInitial(result);
      failed ||= AsyncResult.isFailure(result);
      const page = Option.getOrNull(AsyncResult.value(result));
      hasMore ||= page?.nextCursor != null;
      for (const entry of page?.entries ?? []) {
        const previous = entries.get(entry.tag);
        entries.set(entry.tag, {
          tag: entry.tag,
          count: entry.count + (previous?.count ?? 0),
          projectCount: entry.projectCount + (previous?.projectCount ?? 0),
        });
      }
    }
    const values = [...entries.values()];
    return {
      entries: target.projectId ? values : rankThreadTagVocabulary(values, target.query),
      loading,
      failed,
      hasMore,
    };
  });
});

const isThreadTag = Schema.is(ThreadTag);

export function TagPicker({
  environmentIds,
  projectId,
  selected = [],
  archived = false,
  allowCreate = false,
  disabled = false,
  onSelect,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly projectId?: ProjectId;
  readonly selected?: readonly string[];
  readonly archived?: boolean;
  readonly allowCreate?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (tag: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [projectOnly, setProjectOnly] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const key = JSON.stringify({
    environmentIds,
    projectId,
    projectOnly,
    query: deferredQuery,
    archived,
    cursor,
  });
  const result = useAtomValue(vocabularyPages(key));
  const candidate = query.trim().replace(/^#/, "");
  const canCreate =
    allowCreate &&
    candidate.length > 0 &&
    isThreadTag(candidate) &&
    !result.entries.some((entry) => entry.tag === candidate) &&
    !selected.includes(candidate);
  const options = [...result.entries.map((entry) => entry.tag), ...(canCreate ? [candidate] : [])];
  return (
    <div className="min-w-0 [--command-shell-inset:0.25rem]">
      <Command
        items={options}
        mode="none"
        value={query}
        onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
        onValueChange={(value) => {
          setQuery(value);
          setCursor(0);
          setHighlighted(null);
        }}
      >
        <CommandInput
          aria-label="Search tags"
          placeholder={allowCreate ? "Find or add a tag…" : "Find a tag…"}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              disabled
            )
              return;
            const tag =
              highlighted !== null && options.includes(highlighted) ? highlighted : options[0];
            if (tag === undefined) return;
            (
              event as typeof event & { preventBaseUIHandler?: () => void }
            ).preventBaseUIHandler?.();
            event.preventDefault();
            event.stopPropagation();
            onSelect(tag);
          }}
        />
        <CommandList className="max-h-64">
          {result.entries.map((entry) => (
            <CommandItem
              key={entry.tag}
              value={entry.tag}
              disabled={disabled}
              onClick={() => onSelect(entry.tag)}
            >
              <span className="min-w-0 flex-1 truncate font-mono">#{entry.tag}</span>
              <span
                aria-label={`${entry.count} threads with this tag or nested tags`}
                className="text-xs text-muted-foreground"
              >
                {entry.count}
              </span>
              {selected.includes(entry.tag) ? <CheckIcon className="size-3.5" /> : null}
            </CommandItem>
          ))}
          {canCreate ? (
            <CommandItem value={candidate} disabled={disabled} onClick={() => onSelect(candidate)}>
              <PlusIcon className="size-3.5" />
              <span className="truncate">Add #{candidate}</span>
            </CommandItem>
          ) : null}
          {result.loading ? (
            <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
              Loading tags…
            </p>
          ) : null}
          {result.failed ? (
            <p className="px-2 py-1 text-xs text-destructive" role="alert">
              Could not load tags from every connection. This list may be incomplete.
            </p>
          ) : null}
          {!result.loading && !result.failed && options.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {query.trim() ? "No matching tags" : "No tags yet"}
            </p>
          ) : null}
        </CommandList>
      </Command>
      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1">
        {projectId ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setProjectOnly(!projectOnly);
              setCursor(0);
            }}
            aria-label={
              projectOnly
                ? "Showing tags from this project. Switch to all projects."
                : "Showing tags from all projects. Switch to this project."
            }
          >
            {projectOnly ? "This project" : "All projects"}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">All projects</span>
        )}
        <div className="flex gap-1">
          {cursor > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => setCursor(Math.max(0, cursor - 100))}>
              Previous
            </Button>
          ) : null}
          {result.hasMore ? (
            <Button size="xs" variant="ghost" onClick={() => setCursor(cursor + 100)}>
              Next
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
