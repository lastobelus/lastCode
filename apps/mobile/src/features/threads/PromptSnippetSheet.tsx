import type { EnvironmentId, PromptSnippet } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { searchPromptSnippets } from "@t3tools/shared/promptSnippetSearch";
import { useRef, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import {
  Alert,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";

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
  const [mode, setMode] = useState<"search" | "edit">("search");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        title: string;
        text: string;
        originalTitle: string;
        originalText: string;
      }
    >
  >({});
  const [saving, setSaving] = useState(false);
  const [sheetVersion, setSheetVersion] = useState(0);
  const [wide, setWide] = useState(false);
  const closePending = useRef(false);
  const searchRef = useRef<TextInputInstance>(null);
  const state = useEnvironmentQuery(
    promptSnippetsEnvironment.list({ environmentId: props.environmentId, input: {} }),
  );
  const recordUse = useAtomCommand(promptSnippetsEnvironment.recordUse, { reportFailure: false });
  const discover = useAtomCommand(promptSnippetsEnvironment.discover);
  const dismiss = useAtomCommand(promptSnippetsEnvironment.dismiss);
  const restore = useAtomCommand(promptSnippetsEnvironment.restore);
  const save = useAtomCommand(promptSnippetsEnvironment.save);
  const canSave = useAtomValue(promptSnippetsEnvironment.save.permissionAtom(props.environmentId));
  const canRestore = useAtomValue(
    promptSnippetsEnvironment.restore.permissionAtom(props.environmentId),
  );
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

  const selected = state.data?.snippets.find((snippet) => snippet.id === selectedId);
  const draft = selectedId === null ? undefined : drafts[selectedId];
  const title = draft?.title ?? selected?.title ?? "";
  const text = draft?.text ?? selected?.text ?? "";
  const dirty = Object.values(drafts).some(
    (entry) => entry.title !== entry.originalTitle || entry.text !== entry.originalText,
  );
  const updateDraft = (change: { title?: string; text?: string }) => {
    if (selectedId === null) return;
    setDrafts((current) => ({
      ...current,
      [selectedId]: {
        title,
        text,
        originalTitle: selected?.title ?? "",
        originalText: selected?.text ?? "",
        ...current[selectedId],
        ...change,
      },
    }));
  };
  const requestClose = () => {
    if (!dirty && !saving) {
      props.onClose();
      return;
    }
    // Sheet reports dismissal after its native surface closes. Re-present the
    // feature-owned surface while retaining drafts before asking to discard.
    if (closePending.current) return;
    closePending.current = true;
    setSheetVersion((version) => version + 1);
    Alert.alert(
      saving ? "Prompt still saving" : "Discard unsaved changes?",
      undefined,
      saving
        ? [
            {
              text: "OK",
              onPress: () => {
                closePending.current = false;
              },
            },
          ]
        : [
            {
              text: "Keep editing",
              style: "cancel",
              onPress: () => {
                closePending.current = false;
              },
            },
            { text: "Discard changes", style: "destructive", onPress: props.onClose },
          ],
      { cancelable: false },
    );
  };

  return (
    <Sheet key={sheetVersion} title="Common prompts" onClose={requestClose}>
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
            action={
              canRestore
                ? {
                    label: "Undo",
                    onPress: () => {
                      void restore({
                        environmentId: props.environmentId,
                        input: { snippetId: dismissed },
                      }).then((result) => {
                        if (AsyncResult.isSuccess(result)) setDismissed(null);
                      });
                    },
                  }
                : undefined
            }
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
        <View
          className={wide && mode === "edit" ? "flex-row gap-4" : "gap-4"}
          onLayout={(event) => setWide(event.nativeEvent.layout.width >= 640)}
        >
          <View className="min-w-0 flex-1 gap-3">
            {results.map((snippet) => (
              <View key={snippet.id} className="gap-1">
                <Pressable
                  key={snippet.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${mode === "edit" ? "Edit" : "Insert"} ${snippet.title}`}
                  accessibilityState={{ selected: selectedId === snippet.id }}
                  className="gap-1 rounded-xl border border-border px-3.5 py-2.5 active:opacity-60"
                  disabled={saving}
                  onPress={() => {
                    setSelectedId(snippet.id);
                    if (mode === "edit") return;
                    if (dirty) {
                      Alert.alert(
                        "Unsaved changes",
                        "Save your edits first, or close this sheet to discard them.",
                      );
                      return;
                    }
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
                  <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                    {snippet.text}
                  </Text>
                </Pressable>
                {canDismiss ? (
                  <Button
                    label="Dismiss prompt"
                    tone="text"
                    disabled={saving}
                    onPress={() => {
                      const pending = drafts[snippet.id];
                      if (
                        pending &&
                        (pending.title !== pending.originalTitle ||
                          pending.text !== pending.originalText)
                      ) {
                        Alert.alert("Unsaved changes", "Save this prompt before dismissing it.");
                        return;
                      }
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
          </View>
          {mode === "edit" ? (
            <View className="min-w-0 flex-1 gap-3">
              {canSave ? (
                <Button
                  label="New prompt"
                  disabled={saving}
                  onPress={() => {
                    setSelectedId("new");
                  }}
                />
              ) : null}
              {selectedId !== null && (selected || selectedId === "new") ? (
                <>
                  <Text className="text-sm text-foreground-muted">Title</Text>
                  <TextInput
                    accessibilityLabel="Prompt title"
                    maxLength={100}
                    value={title}
                    onChangeText={(value) => updateDraft({ title: value })}
                    readOnly={!canSave || saving}
                    className="rounded-xl border border-input-border bg-input px-3 py-3 font-sans text-base text-foreground"
                  />
                  <Text className="text-sm text-foreground-muted">Prompt</Text>
                  <TextInput
                    accessibilityLabel="Prompt text"
                    maxLength={4000}
                    value={text}
                    onChangeText={(value) => updateDraft({ text: value })}
                    readOnly={!canSave || saving}
                    multiline
                    textAlignVertical="top"
                    className="min-h-40 rounded-xl border border-input-border bg-input px-3 py-3 font-sans text-base text-foreground"
                  />
                  <Button
                    label="Save prompt"
                    tone="primary"
                    loading={saving}
                    disabled={
                      !canSave ||
                      !title.trim() ||
                      !text.trim() ||
                      !draft ||
                      (draft.title === draft.originalTitle && draft.text === draft.originalText)
                    }
                    onPress={() => {
                      if (!canSave || saving || selectedId === null) return;
                      const id = selectedId;
                      setSaving(true);
                      void save({
                        environmentId: props.environmentId,
                        input: {
                          ...(id === "new" ? {} : { snippetId: id }),
                          title,
                          text,
                        },
                      })
                        .then((result) => {
                          if (!AsyncResult.isSuccess(result)) return;
                          setDrafts((current) => {
                            const next = { ...current };
                            delete next[id];
                            return next;
                          });
                          setSelectedId(result.value.id);
                        })
                        .finally(() => setSaving(false));
                    }}
                  />
                </>
              ) : (
                <Text className="text-sm text-foreground-muted">Select a prompt to edit.</Text>
              )}
            </View>
          ) : null}
        </View>
        {results.length === 0 ? (
          <View className="py-4">
            <Text className="text-sm text-foreground-muted">
              {state.isPending ? "Loading common prompts…" : "No prompts found."}
            </Text>
          </View>
        ) : null}
      </ScrollView>
      <View className="flex-row justify-center gap-3 border-t border-border px-4 py-3">
        <Button
          label="Search"
          tone={mode === "search" ? "primary" : "secondary"}
          onPress={() => setMode("search")}
        />
        <Button
          label="Edit"
          tone={mode === "edit" ? "primary" : "secondary"}
          onPress={() => {
            if (selectedId === null && results[0]) setSelectedId(results[0].id);
            setMode("edit");
          }}
        />
      </View>
    </Sheet>
  );
}
