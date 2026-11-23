import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { ComposerHandleRef } from "~/composerHandleContext";
import type { CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { MessageSquareTextIcon, PencilIcon } from "lucide-react";

export function promptSnippetActions(
  composer: ComposerHandleRef | null,
  available: boolean,
  resolve: MessageResolver = m,
): CommandPaletteActionItem[] {
  if (!available) return [];
  return [
    {
      kind: "action",
      value: "action:common-prompts",
      title: resolve(msg("Insert a common prompt")),
      searchTerms: ["prompt", "snippet", "template", "insert", "common"],
      shortcutCommand: "composer.promptSnippets",
      icon: <MessageSquareTextIcon className="size-4" />,
      run: async () => composer?.current?.openControl("composer.promptSnippets"),
    },
    {
      kind: "action",
      value: "action:edit-common-prompts",
      title: resolve(msg("Edit common prompts")),
      searchTerms: ["prompt", "snippet", "template", "edit", "common"],
      shortcutCommand: "composer.editPromptSnippets",
      icon: <PencilIcon className="size-4" />,
      run: async () => composer?.current?.openControl("composer.editPromptSnippets"),
    },
  ];
}
