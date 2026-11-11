import type { PromptSnippet } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

export function PromptSnippetFields(props: {
  readonly snippet: PromptSnippet;
  readonly busy: boolean;
  readonly writable: boolean;
  readonly dirty: boolean;
  readonly onChange: (field: "title" | "text", value: string) => void;
  readonly onSave: () => void;
  readonly onDismiss: (() => void) | undefined;
}) {
  const valid = props.snippet.title.trim().length > 0 && props.snippet.text.trim().length > 0;
  return (
    <section
      aria-label="Edit selected prompt"
      className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5"
    >
      <label className="space-y-2">
        <span className="text-sm font-medium">Title</span>
        <Input
          aria-label="Prompt title"
          value={props.snippet.title}
          maxLength={100}
          readOnly={!props.writable || props.busy}
          onChange={(event) => props.onChange("title", event.target.value)}
        />
      </label>
      <label className="space-y-2">
        <span className="text-sm font-medium">Prompt</span>
        <Textarea
          aria-label="Prompt text"
          value={props.snippet.text}
          maxLength={4000}
          rows={10}
          readOnly={!props.writable || props.busy}
          onChange={(event) => props.onChange("text", event.target.value)}
        />
      </label>
      <div className="mt-auto flex items-center justify-between gap-2">
        {props.onDismiss ? (
          <Button
            type="button"
            variant="ghost-destructive"
            size="sm"
            disabled={props.busy}
            onClick={props.onDismiss}
          >
            {props.snippet.id === "new" ? "Cancel" : "Dismiss prompt"}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          size="sm"
          disabled={!props.writable || !valid || !props.dirty || props.busy}
          onClick={props.onSave}
        >
          {props.busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
