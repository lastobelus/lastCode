import type {
  EnvironmentThreadShell,
  EnvironmentProject,
} from "@t3tools/client-runtime/state/shell";
import { threadTagRelations, taggedThreadSearch } from "@t3tools/client-runtime/thread-tag-search";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { MessageId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { resolveThreadListV2RowStatus } from "../../threads/threadListV2";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { useContentTopInset, useContentBottomInset } from "../../../components/ui/useBarInset";
import { useProjects, useQuietThreadShell } from "../../../state/entities";
import { environmentThreadShells } from "../../../state/threads";
import { requestThreadMessageJump } from "../../threads/threadMessageJump";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useNowMinuteMs } from "../../../lib/clock";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { TagPickerSheet } from "./TagSheet";
import { useTagDiscovery, useTagPreferences, type TagScope } from "./state";

const visibleTitles = Atom.make((get) => {
  const hidden = get(environmentThreadShells.hiddenThreadKeysAtom);
  return new Map(
    get(environmentThreadShells.quietThreadShellsAtom)
      .filter(
        (thread) =>
          !hidden.has(threadKey({ environmentId: thread.environmentId, threadId: thread.id })),
      )
      .map((thread) => [scopedThreadKey(thread.environmentId, thread.id), thread.title]),
  );
});

export function useTagSidebar(
  scopes: readonly TagScope[],
  onSelect: (thread: EnvironmentThreadShell) => void,
  searchQuery: string,
  messageSearch: {
    readonly matches: readonly EnvironmentThreadSearchMatch[];
    readonly query: string;
  },
) {
  const { sidebar: enabled } = useTagPreferences();
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const tag = enabled ? selected : null;
  const control = enabled ? (
    <View className="gap-2 px-4 py-2">
      <Button
        label={tag === null ? "Filter by tag" : `#${tag} and nested tags`}
        tone="text"
        onPress={() => setOpen(true)}
      />
      {tag !== null ? (
        <Button label="Clear tag filter" tone="text" onPress={() => setSelected(null)} />
      ) : null}
      {open ? (
        <TagPickerSheet
          scopes={scopes}
          onSelect={(value) => {
            setSelected(value);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  ) : null;
  return {
    active: tag !== null,
    control,
    results: (header: ReactNode) =>
      tag === null ? null : (
        <TagResults
          scopes={scopes}
          tag={tag}
          searchQuery={searchQuery}
          messageSearch={messageSearch}
          onSelect={onSelect}
          header={header}
        />
      ),
  };
}

function TagResults({
  scopes,
  tag,
  searchQuery,
  messageSearch,
  onSelect,
  header,
}: {
  readonly scopes: readonly TagScope[];
  readonly tag: string;
  readonly searchQuery: string;
  readonly messageSearch: {
    readonly matches: readonly EnvironmentThreadSearchMatch[];
    readonly query: string;
  };
  readonly onSelect: (thread: EnvironmentThreadShell) => void;
  readonly header: ReactNode;
}) {
  const discovery = useTagDiscovery(scopes, "", tag);
  const titles = useAtomValue(visibleTitles);
  const projects = useProjects();
  const top = useContentTopInset();
  const bottom = useContentBottomInset();
  const needle = searchQuery.trim().toLocaleLowerCase();
  const nowMs = useNowMinuteMs();
  const threads = taggedThreadSearch(
    [...discovery.threads].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        threadKey({ environmentId: a.environmentId, threadId: a.id }).localeCompare(
          threadKey({ environmentId: b.environmentId, threadId: b.id }),
        ),
    ),
    searchQuery,
    new Map(
      (messageSearch.query === searchQuery.trim() ? messageSearch.matches : []).map((match) => [
        threadSearchMatchKey(match),
        match,
      ]),
    ),
    nowMs,
  );
  return (
    <ScreenScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="never"
      contentInset={Platform.OS === "ios" ? { top, bottom } : undefined}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      {discovery.loading ? (
        <Text className="px-4 py-3 text-foreground-muted">Finding threads…</Text>
      ) : null}
      {discovery.error ? (
        <Text accessibilityRole="alert" className="px-4 py-3 text-danger-foreground">
          {discovery.error}
        </Text>
      ) : null}
      {!discovery.loading && !discovery.error && threads.length === 0 ? (
        <Text className="px-4 py-3 text-foreground-muted">
          {needle ? "No matching threads." : "No threads with this tag."}
        </Text>
      ) : null}
      {threads.map(({ thread, messageId }) => (
        <TagResultRow
          key={scopedThreadKey(thread.environmentId, thread.id)}
          fallback={thread}
          messageId={messageId}
          projects={projects}
          titles={titles}
          onSelect={onSelect}
        />
      ))}
    </ScreenScrollView>
  );
}

function TagResultRow({
  fallback,
  messageId,
  projects,
  titles,
  onSelect,
}: {
  readonly fallback: EnvironmentThreadShell;
  readonly messageId: MessageId | null | undefined;
  readonly projects: readonly EnvironmentProject[];
  readonly titles: ReadonlyMap<string, string>;
  readonly onSelect: (thread: EnvironmentThreadShell) => void;
}) {
  const thread =
    useQuietThreadShell({ environmentId: fallback.environmentId, threadId: fallback.id }) ??
    fallback;
  const status = resolveThreadListV2RowStatus(thread);
  const label =
    status === "ready" && thread.settledOverride === "settled"
      ? "Settled"
      : status[0]!.toUpperCase() + status.slice(1).replaceAll("-", " ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}, ${label}`}
      className="min-h-12 border-b border-border px-4 py-3"
      onPress={() => {
        if (messageId)
          requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
        onSelect(thread);
      }}
    >
      <Text className="text-base text-foreground">{thread.title}</Text>
      <Text className="text-sm text-foreground-muted">
        {[
          projects.find(
            (project) =>
              project.environmentId === thread.environmentId && project.id === thread.projectId,
          )?.title,
          label,
          ...threadTagRelations(thread).map(({ label, ref }) => {
            const title = titles.get(scopedThreadKey(ref.environmentId, ref.threadId));
            return title ? `${label}: ${title}` : label;
          }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </Pressable>
  );
}
