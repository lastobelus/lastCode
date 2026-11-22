import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/client-runtime/thread-pull-requests";
import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";
import { formatLastCodeVersion, parseLastCodeVersion } from "@t3tools/shared/lastcodeVersionLabel";
import { T, Var, useGT } from "gt-react";
import {
  ArchiveIcon,
  CalendarIcon,
  EyeOffIcon,
  MinusIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

import {
  useProject,
  useQuietThreadShell,
  useQuietThreadShells,
  useThreadRelationshipShells,
} from "../../state/entities";
import { pullRequestEnvironment, usePullRequestList } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import {
  matchesPullRequestQuery,
  rankPullRequestMatches,
} from "../pullRequest/pullRequestList.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Input } from "../ui/input";
import { Select, SelectButton, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import {
  annotationDatePreset,
  makeHideUntilDraft,
  type HideUntilDraft,
} from "./threadAnnotationHideUntil.logic";

type TriggerKind = HideUntilDraft["kind"];
type PullRequestTrigger = NonNullable<
  Extract<HideUntilDraft, { kind: "pull-request-merged" }>["pullRequest"]
>;

const PICKER_LIMIT = 30;
const PR_LIST_LIMIT = 150;

export function ThreadAnnotationHideUntilField({
  threadRef,
  draft,
  onChange,
  serverVersion,
  disabled,
  invalid,
  now,
}: {
  threadRef: ScopedThreadRef;
  draft: HideUntilDraft;
  onChange: (draft: HideUntilDraft) => void;
  serverVersion: string | undefined;
  disabled: boolean;
  invalid: boolean;
  now: number;
}) {
  const gt = useGT();
  const labelId = useId();
  const checkpointAvailable =
    serverVersion !== undefined && parseLastCodeVersion(serverVersion) !== null;
  const triggerOptions = [
    { kind: "none", label: gt("Don't hide"), icon: XIcon },
    {
      kind: "checkpoints",
      label: gt("Checkpoints installed"),
      icon: PackageIcon,
      hint: gt("Reappears after a set number of LastCode installs"),
    },
    {
      kind: "thread-archived",
      label: gt("A thread is archived"),
      icon: ArchiveIcon,
      hint: gt("Waiting on another thread to finish"),
    },
    {
      kind: "pull-request-merged",
      label: gt("A PR is merged"),
      icon: PullRequestGlyph.merged,
      hint: gt("This thread's PRs first, then open PRs"),
    },
    { kind: "date", label: gt("A date"), icon: CalendarIcon, hint: gt("Pacific Time") },
  ] as const;
  const selected = triggerOptions.find((option) => option.kind === draft.kind);
  const SelectedIcon = selected?.icon;
  return (
    <div className="mt-4 space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-1.5 text-sm font-medium" id={labelId}>
        <EyeOffIcon aria-hidden className="size-4 text-muted-foreground" />
        <T>Hide thread until</T>
      </div>
      <Select<TriggerKind>
        disabled={disabled}
        modal={false}
        value={draft.kind}
        onValueChange={(kind) => {
          if (kind !== null && kind !== draft.kind) onChange(makeHideUntilDraft(kind, now));
        }}
      >
        <SelectTrigger aria-labelledby={labelId} size="sm" className="w-fit">
          <span className="flex items-center gap-2">
            {SelectedIcon ? <SelectedIcon aria-hidden className="size-4" /> : null}
            {selected?.label}
          </span>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
          {triggerOptions.map(({ kind, label, icon: Icon, ...option }) => (
            <SelectItem
              key={kind}
              disabled={kind === "checkpoints" && !checkpointAvailable}
              value={kind}
            >
              <span className="flex items-start gap-2">
                <Icon aria-hidden className="mt-0.5 size-4" />
                <span>
                  {label}
                  {"hint" in option ? (
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  ) : null}
                  {kind === "checkpoints" && !checkpointAvailable ? (
                    <span className="block text-xs text-muted-foreground">
                      <T>Requires an installed LastCode checkpoint</T>
                    </span>
                  ) : null}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {draft.kind === "checkpoints" ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <T>
              The next{" "}
              <Var>
                <CheckpointCount
                  value={draft.count}
                  disabled={disabled || !checkpointAvailable}
                  onChange={(count) => onChange({ ...draft, count })}
                />
              </Var>{" "}
              <Var>
                {gt(
                  "{count, plural, one {checkpoint is installed} other {checkpoints are installed}}",
                  {
                    count: Number(draft.count) || 0,
                  },
                )}
              </Var>
            </T>
          </div>
          {serverVersion === undefined ? null : (
            <p className="text-xs text-muted-foreground">
              {gt("This environment is on {version}", {
                version: formatLastCodeVersion(serverVersion),
              })}
            </p>
          )}
        </>
      ) : null}
      {draft.kind === "thread-archived" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <T>
            <Var>
              <ArchiveTargetPicker
                threadRef={threadRef}
                selected={draft.threadId}
                disabled={disabled}
                onSelect={(threadId) => onChange({ ...draft, threadId })}
              />
            </Var>{" "}
            is archived
          </T>
        </div>
      ) : null}
      {draft.kind === "pull-request-merged" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <T>
            <Var>
              <PullRequestTargetPicker
                threadRef={threadRef}
                selected={draft.pullRequest}
                disabled={disabled}
                onSelect={(pullRequest) => onChange({ ...draft, pullRequest })}
              />
            </Var>{" "}
            is merged
          </T>
        </div>
      ) : null}
      {draft.kind === "date" ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input
              aria-label={gt("Date (PT)")}
              className="w-auto"
              disabled={disabled}
              nativeInput
              size="sm"
              type="date"
              value={draft.date}
              onChange={(event) => onChange({ ...draft, date: event.target.value })}
            />
            <Input
              aria-label={gt("Time (PT)")}
              className="w-auto"
              disabled={disabled}
              nativeInput
              size="sm"
              type="time"
              value={draft.time}
              onChange={(event) => onChange({ ...draft, time: event.target.value })}
            />
            <T>PT</T>
          </div>
          {invalid && draft.date && draft.time ? (
            <p className="text-xs text-destructive">
              <T>Choose a future date and time in PT.</T>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["tomorrow", gt("Tomorrow 9 AM")],
                ["monday", gt("Monday 9 AM")],
                ["week", gt("In a week")],
              ] as const
            ).map(([preset, label]) => {
              const value = annotationDatePreset(now, preset);
              const selected = value.date === draft.date && value.time === draft.time;
              return (
                <Button
                  key={preset}
                  aria-pressed={selected}
                  disabled={disabled}
                  size="xs"
                  type="button"
                  variant={selected ? "secondary" : "outline"}
                  onClick={() => onChange(value)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CheckpointCount(props: {
  value: string;
  disabled: boolean;
  onChange: (count: string) => void;
}) {
  const gt = useGT();
  const count = Number(props.value);
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        aria-label={gt("Fewer checkpoints")}
        disabled={props.disabled || count <= 1 || !Number.isSafeInteger(count)}
        size="icon-xs"
        type="button"
        variant="outline"
        onClick={() => props.onChange(String(count - 1))}
      >
        <MinusIcon />
      </Button>
      <Input
        aria-label={gt("Checkpoint count")}
        className="w-14"
        disabled={props.disabled}
        inputMode="numeric"
        nativeInput
        size="compact"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <Button
        aria-label={gt("More checkpoints")}
        disabled={props.disabled || count >= Number.MAX_SAFE_INTEGER}
        size="icon-xs"
        type="button"
        variant="outline"
        onClick={() =>
          props.onChange(String(Number.isSafeInteger(count) && count >= 1 ? count + 1 : 1))
        }
      >
        <PlusIcon />
      </Button>
    </span>
  );
}

function ArchiveTargetPicker({
  threadRef,
  selected,
  onSelect,
  disabled,
}: {
  threadRef: ScopedThreadRef;
  selected: ThreadId | null;
  onSelect: (threadId: ThreadId) => void;
  disabled: boolean;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const target = useQuietThreadShell(
    selected === null ? null : scopeThreadRef(threadRef.environmentId, selected),
  );
  const shells = useQuietThreadShells();
  const related = new Set(useThreadRelationshipShells(threadRef).map((thread) => thread.id));
  const words = query.trim().toLowerCase().split(/\s+/u);
  const candidates = shells
    .filter(
      (shell) =>
        shell.environmentId === threadRef.environmentId &&
        shell.id !== threadRef.threadId &&
        shell.archivedAt === null &&
        words.every((word) => shell.title.toLowerCase().includes(word)),
    )
    .sort(
      (left, right) =>
        Number(related.has(right.id)) - Number(related.has(left.id)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, PICKER_LIMIT)
    .map((shell) => ({ key: shell.id, label: shell.title, value: shell.id }));
  return (
    <TriggerTargetPicker
      label={target?.title ?? (selected === null ? gt("Pick a thread…") : gt("Selected thread"))}
      searchLabel={gt("Search threads")}
      emptyLabel={gt("No active threads found")}
      query={query}
      onQueryChange={setQuery}
      candidates={candidates}
      disabled={disabled}
      onSelect={onSelect}
    />
  );
}

function PullRequestTargetPicker({
  threadRef,
  selected,
  onSelect,
  disabled,
}: {
  threadRef: ScopedThreadRef;
  selected: PullRequestTrigger | null;
  onSelect: (pullRequest: PullRequestTrigger) => void;
  disabled: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ key: string; label: string } | null>(null);
  const shell = useQuietThreadShell(threadRef);
  const project = useProject(
    shell ? scopeProjectRef(threadRef.environmentId, shell.projectId) : null,
  );
  const repository = sourceControlClients.repositorySelector(project?.repositoryIdentity);
  const projectId = project?.id;
  const search = query.trim().replace(/^#(?=\d)/u, "");
  const numeric = /^\d+$/u.test(search);
  const textQuery = !numeric && search.length > 0 ? search : null;
  const settledTextQuery = useDebouncedValue(textQuery, 180);
  const number = numeric ? Number(search) : 0;
  const settledNumber = useDebouncedValue(number, 180);
  const lookup = usePullRequestList(
    !open || projectId === undefined || repository === null
      ? []
      : [
          {
            environmentId: threadRef.environmentId,
            input: {
              state: "open",
              projectId,
              limit: PR_LIST_LIMIT,
              ...(settledTextQuery === null ? {} : { query: settledTextQuery }),
            },
          },
        ],
  );
  const inOrigin = (entry: { projectId: string; repository: string }) =>
    entry.projectId === projectId &&
    entry.repository.trim().toLowerCase() === repository?.trim().toLowerCase();
  const entries = (lookup.data?.entries ?? []).filter(
    (entry) => entry.state === "open" && inOrigin(entry),
  );
  const exact = useEnvironmentQuery(
    open &&
      number === settledNumber &&
      Number.isSafeInteger(number) &&
      number > 0 &&
      repository !== null &&
      projectId !== undefined &&
      !entries.some((entry) => entry.number === number)
      ? pullRequestEnvironment.detail({
          environmentId: threadRef.environmentId,
          input: { projectId, repository, number },
        })
      : null,
  ).data;
  const exactMatch =
    exact?.number === number && exact.state === "open" && inOrigin(exact)
      ? [{ ...exact, host: legacyThreadPullRequestKey(exact).host }]
      : [];
  const matches =
    projectId === undefined || repository === null
      ? []
      : (() => {
          const linked = composerPullRequestsFromLinks(shell?.pullRequests ?? [], projectId).filter(
            inOrigin,
          );
          const matchingEntries = numeric
            ? filterComposerPullRequestMatches({
                entries: [...exactMatch, ...entries],
                projectId,
                repository,
                query: search,
                limit: PICKER_LIMIT,
                keyOf: (entry) => threadPullRequestKeyOf(entry),
              })
            : rankPullRequestMatches(
                entries.filter(
                  (entry) =>
                    matchesPullRequestQuery(entry, search) ||
                    (settledTextQuery === search &&
                      lookup.data?.providers.some(
                        (provider) => provider.host === entry.host && provider.searchesOnHost,
                      ) === true),
                ),
                search,
              );
          return withLinkedComposerPullRequestsFirst({
            matches: matchingEntries,
            linked,
            query: search,
            limit: PICKER_LIMIT,
            keyOf: (entry) => threadPullRequestKeyOf(entry),
          });
        })();
  const candidates = matches.map(({ title, number, repository, host }) => ({
    key: threadPullRequestKeyOf({ repository, host, number }),
    label: `#${number} · ${title}`,
    value: { kind: "pull-request-merged" as const, repository, host, number },
  }));
  const key = selected ? threadPullRequestKeyOf(selected) : null;
  const selectedLabel =
    candidates.find((candidate) => candidate.key === key)?.label ??
    (picked?.key === key ? picked?.label : undefined) ??
    (selected === null ? gt("Pick a PR…") : gt("PR #{number}", { number: selected.number }));
  return (
    <TriggerTargetPicker
      label={selectedLabel}
      searchLabel={gt("Search pull requests")}
      emptyLabel={
        repository === null
          ? gt("This project has no pull request repository")
          : lookup.isPending
            ? gt("Loading pull requests…")
            : lookup.error
              ? gt("Couldn't load pull requests")
              : gt("No pull requests found in this repository.")
      }
      query={query}
      onQueryChange={setQuery}
      onOpenChange={setOpen}
      candidates={candidates}
      disabled={disabled}
      onSelect={(value, key, label) => {
        setPicked({ key, label });
        onSelect(value);
      }}
    />
  );
}

function TriggerTargetPicker<Value>({
  label,
  searchLabel,
  emptyLabel,
  query,
  onQueryChange,
  onOpenChange,
  candidates,
  disabled,
  onSelect,
}: {
  label: string;
  searchLabel: string;
  emptyLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  onOpenChange?: (open: boolean) => void;
  candidates: readonly { key: string; value: Value; label: string }[];
  disabled: boolean;
  onSelect: (value: Value, key: string, label: string) => void;
}) {
  const keys = candidates.map((candidate) => candidate.key);
  return (
    <Combobox
      autoHighlight
      disabled={disabled}
      filter={null}
      filteredItems={keys}
      items={keys}
      value={null}
      onOpenChange={(open) => {
        onOpenChange?.(open);
        if (!open) onQueryChange("");
      }}
      onValueChange={(key) => {
        const candidate = candidates.find((entry) => entry.key === key);
        if (candidate) onSelect(candidate.value, candidate.key, candidate.label);
      }}
    >
      <ComboboxTrigger
        render={
          <SelectButton size="sm" className="w-auto max-w-full">
            <span className="flex min-w-0 items-center gap-2">
              <SearchIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </span>
          </SelectButton>
        }
      />
      <ComboboxPopup className="w-80">
        <ComboboxSearchInput
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <ComboboxList className="max-h-60">
          {candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">{emptyLabel}</p>
          ) : (
            candidates.map((candidate, index) => (
              <ComboboxItem key={candidate.key} index={index} value={candidate.key}>
                <span className="truncate">{candidate.label}</span>
              </ComboboxItem>
            ))
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
