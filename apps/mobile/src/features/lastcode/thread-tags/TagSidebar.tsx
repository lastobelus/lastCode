import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadTagRelations } from "@t3tools/client-runtime/thread-tag-search";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveThreadListV2RowStatus } from "../../threads/threadListV2";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { useProjects, useVisibleThreadShells } from "../../../state/entities";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { requestThreadMessageJump } from "../../threads/threadMessageJump";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useNowMinuteMs } from "../../../lib/clock";
import { taggedThreadSearch } from "./search";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { TagPickerSheet } from "./TagSheet";
import { useTagDiscovery, useTagPreferences, type TagScope } from "./state";

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
  const projects = useProjects();
  const visibleThreads = useVisibleThreadShells();
  const titles = new Map(
    visibleThreads.map((thread) => [
      scopedThreadKey(thread.environmentId, thread.id),
      thread.title,
    ]),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const tag = enabled ? selected : null;
  const discovery = useTagDiscovery(tag === null ? [] : scopes, "", tag);
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
  const needle = searchQuery.trim().toLocaleLowerCase();
  const nowMs = useNowMinuteMs();
  const threads = taggedThreadSearch(
    discovery.threads,
    searchQuery,
    new Map(
      (messageSearch.query === searchQuery.trim() ? messageSearch.matches : []).map((match) => [
        threadSearchMatchKey(match),
        match,
      ]),
    ),
    nowMs,
  );
  const results =
    tag === null ? null : (
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
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
          <Pressable
            key={JSON.stringify([thread.environmentId, thread.id])}
            accessibilityRole="button"
            accessibilityLabel={thread.title}
            className="min-h-12 border-b border-border px-4 py-3"
            onPress={() => {
              if (messageId)
                requestThreadMessageJump(
                  scopedThreadKey(thread.environmentId, thread.id),
                  messageId,
                );
              onSelect(thread);
            }}
          >
            <Text className="text-base text-foreground">{thread.title}</Text>
            <Text className="text-sm text-foreground-muted">
              {[
                projects.find(
                  (project) =>
                    project.environmentId === thread.environmentId &&
                    project.id === thread.projectId,
                )?.title,
                resolveThreadListV2RowStatus(thread) === "ready" &&
                thread.settledOverride === "settled"
                  ? "Settled"
                  : resolveThreadListV2RowStatus(thread).replaceAll("-", " "),
                ...threadTagRelations(thread).map(({ label, ref }) => {
                  const title = titles.get(scopedThreadKey(ref.environmentId, ref.threadId));
                  return title ? `${label}: ${title}` : label;
                }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Pressable>
        ))}
      </ScreenScrollView>
    );
  return { active: tag !== null, control, results };
}
