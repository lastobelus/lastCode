import { Decoration, type EditorView } from "@tiptap/pm/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComposerCodeBlockLanguagePicker } from "~/components/chat/ComposerCodeBlockLanguagePicker";
import type { ComposerPreviewWidget } from "~/lastcodeComposerLivePreview";

type WidgetPosition = () => number | undefined;
type WidgetAppearance = { theme: "light" | "dark"; editable: boolean };
type WidgetActions = {
  toggleTask: (view: EditorView, getPos: WidgetPosition) => void;
  replaceFenceLanguage: (view: EditorView, getPos: WidgetPosition, language: string) => boolean;
};
type WidgetContent = {
  identity: string;
  mount: (element: HTMLElement, view: EditorView, getPos: WidgetPosition) => void;
};

const widgetRoots = new WeakMap<Node, Root>();

const bulletContent: WidgetContent = {
  identity: "bullet:",
  mount(element) {
    element.className = "composer-md-bullet";
    element.textContent = "• ";
    element.setAttribute("aria-hidden", "true");
  },
};

function stopWidgetEvent() {
  return true;
}

function destroyWidget(element: Node) {
  const root = widgetRoots.get(element);
  if (!root) return;
  widgetRoots.delete(element);
  queueMicrotask(() => root.unmount());
}

function taskContent(
  checked: boolean,
  appearance: WidgetAppearance,
  actions: WidgetActions,
): WidgetContent {
  return {
    identity: `task:${checked}`,
    mount(element, view, getPos) {
      element.className = "composer-md-checkbox";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      input.disabled = !appearance.editable;
      input.setAttribute("aria-label", "Toggle task");
      element.addEventListener("mousedown", (event) => event.preventDefault());
      input.addEventListener("change", () => {
        // Native checkbox state flips before change; source alone owns its state.
        input.checked = checked;
        actions.toggleTask(view, getPos);
      });
      element.append(input);
    },
  };
}

function fenceContent(
  language: string,
  appearance: WidgetAppearance,
  actions: WidgetActions,
): WidgetContent {
  return {
    identity: `fenceHeader:${language}`,
    mount(element, view, getPos) {
      element.className = "composer-md-fence-header";
      const root = createRoot(element);
      widgetRoots.set(element, root);
      queueMicrotask(() => {
        if (widgetRoots.get(element) !== root) return;
        root.render(
          createElement(ComposerCodeBlockLanguagePicker, {
            language,
            theme: appearance.theme,
            disabled: !appearance.editable,
            onChange: (nextLanguage: string) => {
              if (actions.replaceFenceLanguage(view, getPos, nextLanguage)) view.focus();
            },
          }),
        );
      });
    },
  };
}

function widgetContent(
  widget: ComposerPreviewWidget,
  appearance: WidgetAppearance,
  actions: WidgetActions,
): WidgetContent {
  switch (widget.kind) {
    case "bullet":
      return bulletContent;
    case "task":
      return taskContent(widget.checked, appearance, actions);
    case "fenceHeader":
      return fenceContent(widget.language, appearance, actions);
  }
}

/** Own a widget's identity, DOM events and React lifetime independently of document assembly. */
export function createComposerPreviewWidgets(actions: WidgetActions) {
  return (
    position: number,
    widget: ComposerPreviewWidget,
    appearance: WidgetAppearance,
  ): Decoration => {
    const content = widgetContent(widget, appearance, actions);
    return Decoration.widget(
      position,
      (view, getPos) => {
        const element = document.createElement("span");
        element.contentEditable = "false";
        content.mount(element, view, getPos);
        return element;
      },
      {
        key: `${content.identity}:${appearance.theme}:${appearance.editable}`,
        side: -1,
        ignoreSelection: true,
        stopEvent: stopWidgetEvent,
        destroy: destroyWidget,
      },
    );
  };
}
