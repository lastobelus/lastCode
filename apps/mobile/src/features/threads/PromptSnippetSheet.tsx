import type { EnvironmentId, PromptSnippet } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { searchPromptSnippets } from "@t3tools/shared/promptSnippetSearch";
import { useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { Pressable, ScrollView, View, type TextInputInstance } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SearchField } from "../../components/ui/SearchField";
import { Sheet } from "../../components/ui/Sheet";
import { Button } from "../../components/ui/Button";
import { Toast } from "../../components/ui/Toast";
import { promptSnippetsEnvironment } from "../../state/promptSnippets";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function PromptSnippetSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onSelect: (snippet: PromptSnippet) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<TextInputInstance>(null);
  const state = useEnvironmentQuery(
    promptSnippetsEnvironment.list({ environmentId: props.environmentId, input: {} }),
  );
  const recordUse = useAtomCommand(promptSnippetsEnvironment.recordUse, { reportFailure: false });
  const discover = useAtomCommand(promptSnippetsEnvironment.discover);
  const dismiss = useAtomCommand(promptSnippetsEnvironment.dismiss);
  const restore = useAtomCommand(promptSnippetsEnvironment.restore);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const canDismiss = useAtomValue(
    promptSnippetsEnvironment.dismiss.permissionAtom(props.environmentId),
  );
  const canLearn = useAtomValue(
    promptSnippetsEnvironment.recordUse.permissionAtom(props.environmentId),
  );
  const canDiscover = useAtomValue(
    promptSnippetsEnvironment.discover.permissionAtom(props.environmentId),
  );
  const [refreshing, setRefreshing] = useState(false);
  const results = searchPromptSnippets(state.data?.snippets ?? [], query);

  return (
    <Sheet title="Common prompts" onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-3 px-4 pb-8"
      >
        <SearchField
          inputRef={searchRef}
          accessibilityLabel="Search common prompts"
          clearAccessibilityLabel="Clear search"
          placeholder="Search common prompts"
          value={query}
          onChangeText={setQuery}
        />
        {dismissed ? (
          <Toast
            message="Prompt dismissed"
            action={{
              label: "Undo",
              onPress: () => {
                void restore({
                  environmentId: props.environmentId,
                  input: { snippetId: dismissed },
                }).then((result) => {
                  if (AsyncResult.isSuccess(result)) setDismissed(null);
                });
              },
            }}
            onDismiss={() => setDismissed(null)}
          />
        ) : null}
        {canDiscover ? (
          <Button
            label="Find new prompts"
            tone="text"
            loading={refreshing || state.data?.discovering === true}
            onPress={() => {
              setRefreshing(true);
              void discover({ environmentId: props.environmentId, input: {} }).finally(() =>
                setRefreshing(false),
              );
            }}
          />
        ) : null}
        {state.data?.discovering ? (
          <Text className="text-sm text-foreground-muted">Finding common prompts…</Text>
        ) : null}
        {state.error || state.data?.lastError ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
            {state.error ?? state.data?.lastError}
          </Text>
        ) : null}
        {results.map((snippet) => (
          <View key={snippet.id} className="gap-1">
            <Pressable
              key={snippet.id}
              accessibilityRole="button"
              accessibilityLabel={`Insert ${snippet.title}`}
              className="gap-1 rounded-xl border border-border px-3.5 py-2.5 active:opacity-60"
              onPress={() => {
                props.onSelect(snippet);
                if (canLearn)
                  void recordUse({
                    environmentId: props.environmentId,
                    input: { snippetId: snippet.id, query },
                  });
              }}
            >
              <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
                {snippet.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                {snippet.text}
              </Text>
            </Pressable>
            {canDismiss ? (
              <Button
                label="Dismiss prompt"
                tone="text"
                onPress={() => {
                  void dismiss({
                    environmentId: props.environmentId,
                    input: { snippetId: snippet.id },
                  }).then((result) => {
                    if (AsyncResult.isSuccess(result)) setDismissed(snippet.id);
                  });
                }}
              />
            ) : null}
          </View>
        ))}
        {results.length === 0 ? (
          <View className="py-4">
            <Text className="text-sm text-foreground-muted">
              {state.isPending ? "Loading common prompts…" : "No prompts found."}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
