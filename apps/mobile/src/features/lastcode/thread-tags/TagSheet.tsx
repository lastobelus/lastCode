import { useEnvironmentThread } from "../../../state/threads";
import { uuidv4 } from "../../../lib/uuid";
import { useAtomValue } from "@effect/atom-react";
import { CommandId, type EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { ScrollView, View, type TextInputInstance } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { SearchField } from "../../../components/ui/SearchField";
import { Sheet } from "../../../components/ui/Sheet";
import { useThreadShell } from "../../../state/entities";
import { useAtomCommand } from "../../../state/use-atom-command";
import { tagCommands, useTagDiscovery, type TagScope } from "./state";

export function TagPickerSheet(props: {
  readonly scopes: readonly TagScope[];
  readonly preferredProjectId?: ProjectId;
  readonly onSelect: (tag: string) => void;
  readonly onClose: () => void;
  readonly error?: string | null;
  readonly editor?: {
    readonly tags: readonly string[];
    readonly disabled: boolean;
    readonly set: (tag: string, tagged: boolean) => void;
  };
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<TextInputInstance>(null);
  const discovery = useTagDiscovery(props.scopes, query, null, props.preferredProjectId);
  const tags = [...new Set(discovery.entries.map((entry) => entry.tag))];
  const exact = query.trim().replace(/^#/, "");
  const canAdd =
    props.editor !== undefined &&
    exact.length > 0 &&
    exact.length <= 64 &&
    !/[\p{Cc}]/u.test(exact) &&
    !props.editor.tags.includes(exact);
  return (
    <Sheet title={props.editor ? "Thread tags" : "Filter by tag"} onClose={props.onClose}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-4 pb-8"
      >
        <SearchField
          inputRef={searchRef}
          accessibilityLabel="Search tags"
          clearAccessibilityLabel="Clear tag search"
          placeholder={props.editor ? "Find or add a tag" : "Find a tag"}
          value={query}
          onChangeText={setQuery}
        />
        {props.editor?.tags.map((tag) => (
          <Button
            key={tag}
            label={`Remove #${tag}`}
            tone="secondary"
            disabled={props.editor?.disabled}
            onPress={() => props.editor?.set(tag, false)}
          />
        ))}
        {canAdd && props.editor ? (
          <Button
            label={`Add #${exact}`}
            disabled={props.editor.disabled}
            onPress={() => props.editor?.set(exact, true)}
          />
        ) : null}
        {props.error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {props.error}
          </Text>
        ) : null}
        {discovery.loading ? <Text className="text-foreground-muted">Loading tags…</Text> : null}
        {discovery.error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {discovery.error}
          </Text>
        ) : null}
        {tags
          .filter((tag) => !props.editor?.tags.includes(tag))
          .map((tag) => (
            <Button
              key={tag}
              label={`#${tag}`}
              tone="text"
              disabled={props.editor?.disabled}
              onPress={() => props.onSelect(tag)}
            />
          ))}
        {!discovery.loading &&
        !discovery.error &&
        tags.length === 0 &&
        !canAdd &&
        !props.editor?.tags.length ? (
          <Text className="text-foreground-muted">
            {query.trim() ? "No matching tags." : "No tags yet."}
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

export function ThreadTagEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const thread = useThreadShell(props);
  const detail = useEnvironmentThread(props.environmentId, props.threadId);
  const tags = Option.isSome(detail.data) ? (detail.data.value.thread.tags ?? []) : [];
  const permitted = useAtomValue(tagCommands.set.permissionAtom(props.environmentId));
  const setTag = useAtomCommand(tagCommands.set);
  const [saving, setSaving] = useState(false);
  const writeInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const write = (tag: string, tagged: boolean) => {
    if (!permitted || writeInFlight.current) return;
    writeInFlight.current = true;
    setSaving(true);
    setError(null);
    void setTag({
      environmentId: props.environmentId,
      input: {
        type: "thread.tag.set",
        commandId: CommandId.make(uuidv4()),
        threadId: props.threadId,
        tag,
        tagged,
      },
    })
      .then((result) => {
        if (!AsyncResult.isSuccess(result)) setError("Could not update this tag. Try again.");
      })
      .finally(() => {
        writeInFlight.current = false;
        setSaving(false);
      });
  };
  return (
    <View>
      <TagPickerSheet
        error={error}
        scopes={[{ environmentId: props.environmentId }]}
        {...(thread ? { preferredProjectId: thread.projectId } : {})}
        onClose={props.onClose}
        onSelect={(tag) => write(tag, true)}
        editor={{
          tags,
          disabled: !permitted || saving || !thread || !Option.isSome(detail.data),
          set: write,
        }}
      />
    </View>
  );
}
