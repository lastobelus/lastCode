import type { ComposerHandleRef } from "~/composerHandleContext";
import type { CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { MessageSquareTextIcon, PencilIcon } from "lucide-react";

export function promptSnippetActions(
  composer: ComposerHandleRef | null,
  available: boolean,
): CommandPaletteActionItem[] {
  if (!available) return [];
  return [
    {
      kind: "action",
      value: "action:common-prompts",
      title: "Insert a common prompt",
      searchTerms: ["prompt", "snippet", "template", "insert", "common"],
      shortcutCommand: "composer.promptSnippets",
      icon: <MessageSquareTextIcon className="size-4" />,
      run: async () => composer?.current?.openControl("composer.promptSnippets"),
    },
    {
      kind: "action",
      value: "action:edit-common-prompts",
      title: "Edit common prompts",
      searchTerms: ["prompt", "snippet", "template", "edit", "common"],
      shortcutCommand: "composer.editPromptSnippets",
      icon: <PencilIcon className="size-4" />,
      run: async () => composer?.current?.openControl("composer.editPromptSnippets"),
    },
  ];
}
