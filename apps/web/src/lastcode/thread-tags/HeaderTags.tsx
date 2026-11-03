import { useAtomValue } from "@effect/atom-react";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { XIcon } from "lucide-react";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { setThreadTag } from "./state";
import { TagPicker } from "./TagPicker";

const tagStyle =
  "group inline-flex min-w-0 shrink-0 items-center rounded-sm border border-transparent px-1 text-foreground/30 hover:border-border/50 hover:bg-foreground/5 hover:text-foreground/80 focus-within:border-border/50 focus-within:bg-foreground/5 focus-within:text-foreground/80";

export function HeaderTags({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const enabled = useClientSettings((settings) => settings.lastcodeThreadTagsHeaderEnabled);
  return enabled ? (
    <HeaderTagsContent
      key={`${threadRef.environmentId}/${threadRef.threadId}`}
      threadRef={threadRef}
    />
  ) : null;
}

function HeaderTagsContent({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const canEdit = useAtomValue(setThreadTag.permissionAtom(threadRef.environmentId));
  const update = useAtomCommand(setThreadTag, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!thread) return null;

  async function change(tag: string, tagged: boolean) {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const result = await update({
        environmentId: threadRef.environmentId,
        input: {
          type: "thread.tag.set",
          commandId: CommandId.make(randomUUID()),
          threadId: threadRef.threadId,
          tag,
          tagged,
        },
      });
      if (AsyncResult.isFailure(result)) {
        setError("Could not update this tag. Try again.");
        setOpen(true);
      }
    } catch {
      setError("Could not update this tag. Try again.");
      setOpen(true);
    }
    setSaving(false);
  }

  return (
    <div
      data-lastcode-header-tags
      className="[-webkit-app-region:no-drag] absolute inset-x-0 -ml-1.25 bottom-px flex h-4 min-w-0 items-center gap-1 font-mono text-3xs leading-3 font-semibold"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-center overflow-x-auto empty:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(thread.source.tags ?? []).map((tag) => (
            <span key={tag} className={tagStyle}>
              <PopoverTrigger
                disabled={!canEdit}
                aria-label={`Edit tags: ${tag}`}
                render={
                  <button type="button" className="max-w-40 cursor-pointer truncate outline-none" />
                }
              >
                {tag}
              </PopoverTrigger>
              {canEdit ? (
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  disabled={!canEdit || saving}
                  onClick={() => void change(tag, false)}
                  className="ml-0.5 flex size-3 cursor-pointer items-center justify-center opacity-0 outline-none group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:opacity-100 disabled:cursor-default"
                >
                  <XIcon className="size-2.5" />
                </button>
              ) : null}
            </span>
          ))}
        </div>
        {canEdit ? (
          <PopoverTrigger
            aria-label="Add thread tag"
            render={
              <button
                type="button"
                className={`${tagStyle} cursor-pointer font-light outline-none`}
              />
            }
          >
            +Tag
          </PopoverTrigger>
        ) : null}
        <PopoverPopup
          width="md"
          padding="none"
          align="start"
          animated={false}
          aria-label="Thread tags"
        >
          <TagPicker
            environmentIds={[threadRef.environmentId]}
            projectId={thread.projectId}
            archived={thread.archivedAt !== null}
            selected={thread.source.tags ?? []}
            allowCreate
            disabled={saving || !canEdit}
            onSelect={(tag) => void change(tag, !thread.source.tags?.includes(tag))}
          />
          {error ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </PopoverPopup>
      </Popover>
    </div>
  );
}
