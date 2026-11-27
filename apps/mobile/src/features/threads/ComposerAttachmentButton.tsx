import type { MenuAction } from "@react-native-menu/menu";
import { msg, useGT, useMessages } from "gt-react-native";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: msg("Photo Library"), image: "photo" },
  { id: "files", title: msg("Choose Files"), image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickPromptSnippet?: () => void;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const gt = useGT();
  const m = useMessages();
  const { scale } = useAndroidControlSizing();
  const accessibilityLabel = props.onPickPromptSnippet
    ? gt("Add to message")
    : gt("Add attachment");
  const button = (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      onPress={
        !props.supportsFiles && !props.onPickPromptSnippet
          ? () => void props.onPickMedia()
          : undefined
      }
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled || (!props.supportsFiles && !props.onPickPromptSnippet)) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      actions={[
        ...(props.supportsFiles
          ? ATTACHMENT_MENU_ACTIONS
          : ATTACHMENT_MENU_ACTIONS.filter((action) => action.id === "photos")
        ).map((action) => ({ ...action, title: m(action.title) })),
        ...(props.onPickPromptSnippet
          ? [{ id: "prompt-snippets", title: gt("Common Prompts"), image: "text.bubble" }]
          : []),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "prompt-snippets") {
          props.onPickPromptSnippet?.();
        } else if (nativeEvent.event === "photos") {
          void props.onPickMedia();
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}
