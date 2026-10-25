import { isProviderSkillUserInvocable } from "@t3tools/client-runtime/providerSkills";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import {
  Extension,
  findChildren,
  Node,
  type JSONContent,
  type Editor as TiptapEditor,
} from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { splitBlockKeepMarks } from "@tiptap/pm/commands";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import type {
  AssistantCitation,
  ComposerContextClipboardFragment,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";

import { pastedPathQueryLength } from "~/composer-logic";
import { useStableCallback } from "~/hooks/useStableCallback";
import { caretLineDirection, ComposerTextDirectionExtension } from "~/composer-text-direction";
import {
  collectComposerPromptInlineTokens,
  selectionTouchesMentionBoundary,
} from "~/composer-editor-mentions";
import {
  buildDocJson,
  buildTiptapContent,
  flatToMarkdown,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
  skillChipReplacements,
  type SkillMeta,
} from "~/composer-rich-text-doc";
import {
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "~/composer-undo-grouping";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn, isMacPlatform } from "~/lib/utils";
import { basenameOfPath } from "~/pierre-icons";
import { WorkspaceEntryTooltip } from "./chat/WorkspaceEntryIcon";
import { FileTagChipContent } from "./chat/FileTagChip";
import { SkillChipIcon } from "./chat/SkillInlineText";
import { AssistantCitationChip } from "./chat/AssistantCitationChip";
import { getTimelinePageScrollKey } from "./chat/pageScrollController";
import { ContextChipPopover } from "./contextChipParts";
import { Button } from "./ui/button";
import { ContextChip } from "./ContextChip";
import {
  ComposerContextActionsContext,
  ComposerContextReferenceChip,
  ComposerContextRecordsContext,
} from "./composerContextPresentation";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { resolveAssistantCitationCommentDismissal } from "./chat/assistantCitationCommentDismissal";
import { composerCodeBlockHighlight } from "./composerCodeBlockHighlight";
import { importPastedComposerText } from "./composerInlineTokenPaste";
import { didComposerSelectionChangeVisibly } from "./composerSelection";
import {
  ComposerLivePreviewExtension,
  composerLivePreviewKey,
  handleComposerSourceKey,
  wrapComposerSourceSelection,
} from "~/lastcodeComposerLivePreviewTiptap";
import { normalizeComposerSourceSlice } from "~/lastcodeComposerSourceSlice";
import { composerFormattingDelimiterForShortcut } from "~/lastcodeComposerSourceShortcuts";
import {
  handleComposerSourcePaste,
  resolveComposerSourcePosition,
  suppressComposerSourceTrigger,
} from "~/lastcodeComposerSourceHooks";
import type { ComposerDraftContextRecords } from "./composerContextPresentation";

export interface ComposerPromptEditorHandle {
  focus: () => void;
  /** Focus at an expanded source offset; the actual document decides which ranges are atoms. */
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSelectionRange: () => { start: number; end: number };
  requestCitationComment: (request: ComposerCitationCommentRequest) => void;
  readSnapshot: () => {
    value: string;
    /** Actual document offset, counting each current atom as one position. */
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  isCaretOnVisualEdge: (edge: "start" | "end") => boolean;
}

export interface ComposerPromptEditorProps {
  draftKey?: string;
  value: string;
  /** Expanded source offset, independent of whether a token currently renders as an atom. */
  cursor: number;
  richTextEnabled?: boolean;
  literalText?: boolean;
  contextRecords: ComposerDraftContextRecords;
  buildContextClipboardFragment?:
    | ((contextIds: ReadonlyArray<string>) => string | null)
    | undefined;
  importContextFragment?:
    | ((fragment: ComposerContextClipboardFragment) => ReadonlyMap<string, string>)
    | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string | undefined;
  suggestionListId?: string | undefined;
  activeSuggestionId?: string | undefined;
  isPathQueryActive?: () => boolean;
  containerClassName?: string;
  className?: string;
  placeholderClassName?: string;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    contextIds: string[],
  ) => void;
  onVisibleSelectionChange?: () => void;
  onCommandKeyDown?: (key: string, event: KeyboardEvent, isTaskItem?: boolean) => boolean;
  onPageScrollKeyDown?: (key: "PageUp" | "PageDown") => void;
  onPageScrollKeyUp?: (key: string) => void;
  onPageScrollRelease?: () => void;
  onCitationSubmitAndSend?: () => void;
  onCitationDraftSave?: (replacedValue: string, savedValue: string) => void;
  onPaste: React.ClipboardEventHandler<HTMLElement>;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}

export type ComposerCitationCommentRequest = {
  previousValue: string;
  value: string;
  citationStart: number;
  sourceAnchor: AssistantCitationSourceAnchor;
  insertedSpaces: CitationInsertedSpaces;
};

type CitationInsertedSpaces = { before: boolean; after: boolean };

type OpenCitationComment = {
  key: string;
  sourceAnchor?: AssistantCitationSourceAnchor;
  removeOnCancel?: CitationInsertedSpaces;
};

const ComposerCitationCommentContext = createContext<{
  openComment: OpenCitationComment | null;
  onOpenChange: (citeKey: string, open: boolean) => void;
  onDraftChange: (citeKey: string, comment: string) => void;
  onSubmitAndSend: () => void;
}>({
  openComment: null,
  onOpenChange: () => {},
  onDraftChange: () => {},
  onSubmitAndSend: () => {},
});

const RichComposerSkillsContext = createContext<ReadonlyArray<ServerProviderSkill>>([]);

const SURROUND_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "'": "'",
  '"': '"',
  "“": "”",
  "`": "`",
  "<": ">",
  "«": "»",
  "*": "*",
  _: "_",
};

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const CHIP_NODE_SELECTION_CLASS_NAME =
  "relative inline-flex select-none items-center align-middle leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

const ComposerMentionExtension = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-mention": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerMentionNodeView);
  },
});

function ComposerMentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const path = (node.attrs.path as string) ?? "";
  const chip = (
    <ContextChip
      kind="mention"
      dir="ltr"
      render={<button type="button" />}
      onClick={() => actions.openMention(path)}
      aria-label={`Preview ${path}`}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent
        path={path}
        environmentId={actions.environmentId}
        cwd={actions.cwd}
        label={basenameOfPath(path)}
        theme={resolvedThemeFromDocument()}
      />
    </ContextChip>
  );
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top">
          <WorkspaceEntryTooltip
            path={path}
            environmentId={actions.environmentId}
            cwd={actions.cwd}
          />
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}

const ComposerSkillExtension = Node.create({
  name: "composer-skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-skill]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-skill": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerSkillNodeView);
  },
});

/** Chip presentation for `$name`, or null when the provider does not offer it to users. */
function composerSkillMeta(
  skills: ReadonlyArray<ServerProviderSkill>,
  name: string,
): SkillMeta | null {
  const skill = skills.find(
    (candidate) => candidate.name === name && isProviderSkillUserInvocable(candidate),
  );
  if (!skill) return null;
  const shortDescription = skill.shortDescription?.trim();
  return {
    label: formatProviderSkillDisplayName(skill),
    description: shortDescription || skill.description?.trim() || null,
  };
}

function ComposerSkillNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const skills = use(RichComposerSkillsContext);
  const skillName = (node.attrs.skillName as string) ?? "";
  const skillDescription = (node.attrs.skillDescription as string | null) ?? null;
  const skill = skills.find(
    (candidate) => candidate.name === skillName && isProviderSkillUserInvocable(candidate),
  );
  const description = skill
    ? skill.description?.trim() || skill.shortDescription?.trim()
    : skillDescription;
  // The node outlives a provider switch, so its stored label can be another provider's.
  const skillLabel = skill
    ? formatProviderSkillDisplayName(skill)
    : (node.attrs.skillLabel as string) || skillName;
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <ContextChipPopover
        kind="skill"
        icon={<SkillChipIcon />}
        label={skillLabel}
        accessibleLabel={`Skill ${skillLabel}`}
      >
        <div className="space-y-3 p-2 text-sm">
          <p className="font-medium">{skillLabel}</p>
          <p>{description || "No description is available for this skill."}</p>
          {skill?.path && actions.environmentId ? (
            <Button variant="outline" size="sm" onClick={() => actions.openMention(skill.path)}>
              View instructions
            </Button>
          ) : null}
        </div>
      </ContextChipPopover>
    </NodeViewWrapper>
  );
}

const ComposerCitationExtension = Node.create({
  name: "composer-citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-citation]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-citation": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerCitationNodeView);
  },
});

function ComposerCitationNodeView({ node, editor, getPos }: NodeViewProps) {
  const commentContext = use(ComposerCitationCommentContext);
  const citation = node.attrs.citation as AssistantCitation;
  const citeKey = node.attrs.citeKey as string;
  const commentTarget =
    commentContext.openComment?.key === citeKey ? commentContext.openComment : null;

  const nodePos = () => {
    const pos = typeof getPos === "function" ? getPos() : null;
    return typeof pos === "number" ? pos : null;
  };

  const onSaveComment = (comment: string): boolean => {
    if (!editor.isEditable) return false;
    const pos = nodePos();
    if (pos === null) return false;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "composer-citation") return false;
    const currentCitation = current.attrs.citation as AssistantCitation;
    const next = withAssistantCitationComment(currentCitation, comment);
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
      ...current.attrs,
      citation: next,
      source: serializeAssistantCitation(next),
    });
    editor.view.dispatch(tr);
    return true;
  };

  const removeOnCancel = commentTarget?.removeOnCancel;
  const onRemove = () => {
    if (!editor.isEditable || !removeOnCancel) return;
    const pos = nodePos();
    if (pos === null) return;
    const { doc } = editor.state;
    const current = doc.nodeAt(pos);
    if (!current) return;
    const end = pos + current.nodeSize;
    const from = removeOnCancel.before && doc.textBetween(pos - 1, pos) === " " ? pos - 1 : pos;
    const to = removeOnCancel.after && doc.textBetween(end, end + 1) === " " ? end + 1 : end;
    editor.chain().focus().deleteRange({ from, to }).run();
  };

  const onRestoreFocus = () => {
    if (!editor.isEditable) return;
    const pos = nodePos();
    if (pos === null) return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "composer-citation") return;
    editor.commands.focus(pos + current.nodeSize);
  };

  return (
    <NodeViewWrapper
      as="span"
      className={cn(CHIP_NODE_SELECTION_CLASS_NAME, "min-w-0 max-w-full")}
      contentEditable={false}
      spellCheck={false}
      data-composer-citation-chip="true"
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        if (
          !editor.isEditable ||
          event.key !== "Tab" ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          !(event.target instanceof HTMLElement) ||
          event.target.dataset.citationCommentTrigger === undefined
        ) {
          return;
        }
        event.preventDefault();
        onRestoreFocus();
      }}
    >
      <AssistantCitationChip
        citation={citation}
        composer
        commentEditor={{
          open: commentTarget !== null,
          sourceAnchor: commentTarget?.sourceAnchor,
          onOpenChange: (open) => {
            if (open && !editor.isEditable) return;
            commentContext.onOpenChange(citeKey, open);
          },
          ...(removeOnCancel ? { onCancel: onRemove } : {}),
          onSave: onSaveComment,
          onDraftChange: (comment) => commentContext.onDraftChange(citeKey, comment),
          onSaveAndSend: (comment) => {
            if (!onSaveComment(comment)) return false;
            commentContext.onSubmitAndSend();
            return true;
          },
          onRestoreFocus,
        }}
      />
    </NodeViewWrapper>
  );
}

const ComposerContextReferenceExtension = Node.create({
  name: "composer-context-reference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-context-reference]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-context-reference": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerContextReferenceNodeView);
  },
});

function ComposerContextReferenceNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <ComposerContextReferenceChip
        kind={(node.attrs.kind as string) ?? ""}
        contextId={(node.attrs.contextId as string) ?? ""}
        label={(node.attrs.label as string) ?? ""}
      />
    </NodeViewWrapper>
  );
}

function replaceSkillChips(
  editor: TiptapEditor,
  replacements: ReturnType<typeof skillChipReplacements>,
): void {
  const transaction = editor.state.tr.setMeta("addToHistory", false);
  for (const { from, to, node } of replacements) transaction.replaceWith(from, to, node);
  editor.view.dispatch(transaction);
}

export function ComposerPromptEditorTiptap(props: ComposerPromptEditorProps) {
  const restoreFocusRef = useRef(false);
  return (
    <ComposerPromptEditorTiptapInner
      key={`${props.draftKey ?? ""}:${props.literalText ? "literal" : "source"}`}
      {...props}
      restoreFocusRef={restoreFocusRef}
    />
  );
}

/** Decide grouping in dispatch middleware before the history plugin applies the transaction. */
const ComposerUndoGroupingExtension = Extension.create<
  Record<string, never>,
  { previous: ComposerChangeKind | null }
>({
  name: "composer-undo-grouping",
  addStorage() {
    return { previous: null };
  },
  dispatchTransaction({ transaction, next }) {
    this.storage.previous = groupUndoByChangeKind(transaction, this.storage.previous);
    next(transaction);
  },
});

// Tiptap extension hooks keep a stable config identity across React renders.
const COMPOSER_EXTENSIONS = [
  StarterKit.configure({
    blockquote: false,
    bulletList: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    listItem: false,
    link: false,
    orderedList: false,
    underline: false,
    dropcursor: false,
    gapcursor: false,
    trailingNode: false,
    code: false,
    // Clipboard HTML needs a break node while parsing; transformPasted splits it into source paragraphs.
    // Source paragraphs need no list keymap.
    listKeymap: false,
    undoRedo: { newGroupDelay: COMPOSER_UNDO_GROUP_DELAY },
    // Plain mode has no marks: typed markers stay literal characters.
    bold: false,
    italic: false,
    strike: false,
  }),
  ComposerUndoGroupingExtension,
  ComposerTextDirectionExtension,
  ComposerMentionExtension,
  ComposerSkillExtension,
  ComposerCitationExtension,
  ComposerContextReferenceExtension,
  ComposerLivePreviewExtension,
  composerCodeBlockHighlight({
    resolveTheme: () => resolveDiffThemeName(resolvedThemeFromDocument()),
  }),
];

function ComposerPromptEditorTiptapInner(
  props: ComposerPromptEditorProps & {
    restoreFocusRef: RefObject<boolean>;
  },
) {
  const {
    value,
    cursor,
    richTextEnabled,
    literalText = false,
    contextRecords,
    buildContextClipboardFragment,
    importContextFragment,
    skills,
    disabled,
    placeholder,
    ariaLabel,
    suggestionListId,
    activeSuggestionId,
    isPathQueryActive,
    containerClassName,
    className,
    placeholderClassName,
    onChange,
    onVisibleSelectionChange,
    onCommandKeyDown,
    onPageScrollKeyDown,
    onPageScrollKeyUp,
    onPageScrollRelease,
    onCitationSubmitAndSend,
    onCitationDraftSave,
    onPaste,
    editorRef,
    restoreFocusRef,
  } = props;
  // Both modes keep Markdown characters as source text.
  const richText = !literalText && (richTextEnabled ?? false);
  const clampEditorCursor = (text: string, position: number) =>
    Math.max(
      0,
      Math.min(text.length, Number.isFinite(position) ? Math.floor(position) : text.length),
    );

  const onChangeRef = useRef(onChange);
  const onVisibleSelectionChangeRef = useRef(onVisibleSelectionChange);
  const onCommandKeyDownRef = useRef(onCommandKeyDown);
  const isPathQueryActiveRef = useRef(isPathQueryActive);
  const buildFragmentRef = useRef(buildContextClipboardFragment);
  const importFragmentRef = useRef(importContextFragment);
  const latestValueRef = useRef(value);
  const editorHolder = useRef<TiptapEditor | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onVisibleSelectionChangeRef.current = onVisibleSelectionChange;
  }, [onVisibleSelectionChange]);
  useEffect(() => {
    onCommandKeyDownRef.current = onCommandKeyDown;
  }, [onCommandKeyDown]);
  useEffect(() => {
    isPathQueryActiveRef.current = isPathQueryActive;
  }, [isPathQueryActive]);
  useEffect(() => {
    buildFragmentRef.current = buildContextClipboardFragment;
  }, [buildContextClipboardFragment]);
  useEffect(() => {
    importFragmentRef.current = importContextFragment;
  }, [importContextFragment]);
  useLayoutEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const skillLabelFor = useStableCallback((name: string) =>
    composerSkillMeta(skills, name.startsWith("$") ? name.slice(1) : name),
  );

  const initialExpandedCursor = clampEditorCursor(value, cursor);
  const snapshotRef = useRef({
    value,
    cursor: 0,
    expandedCursor: initialExpandedCursor,
    contextIds: literalText ? [] : collectInlineContextIds(value),
  });
  const selectionRangeRef = useRef({ start: initialExpandedCursor, end: initialExpandedCursor });
  const isApplyingControlledUpdateRef = useRef(false);
  const hasAppliedControlledSelectionRef = useRef(false);
  const citationRequestRef = useRef<ComposerCitationCommentRequest | null>(null);
  const [openCitation, setOpenCitation] = useState<OpenCitationComment | null>(null);
  const citationDraftRef = useRef<{ key: string; comment: string } | null>(null);
  const [isEmpty, setIsEmpty] = useState(value.length === 0);

  const citationCommentActions = {
    openComment: openCitation,
    onOpenChange: (nodeKey: string, open: boolean) => {
      if (!open && citationDraftRef.current?.key === nodeKey) citationDraftRef.current = null;
      setOpenCitation((current) => {
        if (open) {
          if (current?.key === nodeKey) return current;
          return { key: nodeKey };
        }
        return current?.key === nodeKey ? null : current;
      });
    },
    onDraftChange: (nodeKey: string, comment: string) => {
      citationDraftRef.current = { key: nodeKey, comment };
    },
    onSubmitAndSend: onCitationSubmitAndSend ?? (() => {}),
  };

  const handleEditorChange = (updated: TiptapEditor, refreshSuggestions = false) => {
    const map = serializeEditorDoc(updated.state.doc);
    // Literal answers hold no chips, so reference-shaped text is not a context.
    const contextIds = literalText ? [] : map.contextIds;
    const { from, to } = updated.state.selection;
    const fromFlat = pmToFlat(map, from);
    const toFlat = pmToFlat(map, to);
    const nextValue = map.value;
    const nextCursor = fromFlat;
    const nextExpandedCursor = Math.max(
      0,
      Math.min(map.value.length, flatToMarkdown(map, fromFlat)),
    );
    const nextSelectionRange = {
      start: Math.min(nextExpandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(nextExpandedCursor, flatToMarkdown(map, toFlat)),
    };
    const previousSelectionRange = selectionRangeRef.current;
    selectionRangeRef.current = nextSelectionRange;
    setIsEmpty(nextValue.length === 0);
    const previousSnapshot = snapshotRef.current;
    const snapshotChanged = !(
      previousSnapshot.value === nextValue &&
      previousSnapshot.cursor === nextCursor &&
      previousSnapshot.expandedCursor === nextExpandedCursor &&
      previousSnapshot.contextIds.length === contextIds.length &&
      previousSnapshot.contextIds.every((id, index) => id === contextIds[index])
    );
    if (isApplyingControlledUpdateRef.current) return;
    if (!snapshotChanged && !refreshSuggestions) {
      if (didComposerSelectionChangeVisibly(previousSelectionRange, nextSelectionRange)) {
        onVisibleSelectionChangeRef.current?.();
      }
      return;
    }
    // Ignore selection-only updates while a controlled rewrite is pending to avoid overwriting the new
    // prompt.
    if (previousSnapshot.value === nextValue && nextValue !== latestValueRef.current) {
      return;
    }
    snapshotRef.current = {
      value: nextValue,
      cursor: nextCursor,
      expandedCursor: nextExpandedCursor,
      contextIds,
    };
    const suppressTrigger = suppressComposerSourceTrigger(updated.state, map, literalText);
    onChangeRef.current(nextValue, nextCursor, nextExpandedCursor, suppressTrigger, contextIds);
  };

  const editorAttributes = {
    class: cn(
      "composer-tiptap -m-1 block max-h-52 min-h-19.5 overflow-y-auto p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
      className,
    ),
    "data-testid": "composer-editor",
    "data-composer-rich-text": richText ? "true" : "false",
    "data-lastcode-source-composer": "true",
    role: "textbox",
    "aria-multiline": "true",
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(disabled ? { "aria-readonly": "true" } : {}),
    ...(!disabled && suggestionListId
      ? {
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          ...(activeSuggestionId
            ? {
                "aria-controls": suggestionListId,
                "aria-activedescendant": activeSuggestionId,
              }
            : {}),
        }
      : {}),
    "aria-placeholder": placeholder,
  };

  const editor = useEditor(
    {
      extensions: COMPOSER_EXTENSIONS,
      content: buildDocJson(value, (name) => composerSkillMeta(skills, name), {
        styling: richText,
        literalText,
      }),
      editable: !disabled,
      editorProps: {
        attributes: editorAttributes,
        transformPasted: (slice, view) => normalizeComposerSourceSlice(slice, view.state.schema),
        handleKeyDown: (view, event) => {
          const backArrow = caretLineDirection(view.state) === "rtl" ? "ArrowRight" : "ArrowLeft";
          const boundary = event.metaKey
            ? event.key === "ArrowLeft" || event.key === "ArrowRight"
              ? "lineboundary"
              : event.key === "ArrowUp" || event.key === "ArrowDown"
                ? "documentboundary"
                : null
            : event.key === "Home" || event.key === "End"
              ? "lineboundary"
              : null;
          if (
            isMacPlatform(navigator.platform) &&
            boundary &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.isComposing
          ) {
            const selection = window.getSelection();
            if (
              selection?.anchorNode &&
              view.dom.contains(selection.anchorNode) &&
              typeof selection.modify === "function"
            ) {
              event.preventDefault();
              event.stopPropagation();
              const backward =
                event.key === "Home" || event.key === "ArrowUp" || event.key === backArrow;
              selection.modify(
                event.shiftKey ? "extend" : "move",
                backward ? "backward" : "forward",
                boundary,
              );
              if (selection.anchorNode && selection.focusNode) {
                const tr = view.state.tr.setSelection(
                  TextSelection.create(
                    view.state.doc,
                    view.posAtDOM(selection.anchorNode, selection.anchorOffset),
                    view.posAtDOM(selection.focusNode, selection.focusOffset),
                  ),
                );
                view.dispatch(tr.scrollIntoView());
              }
              return true;
            }
          }
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection;
            const direction = event.key === "ArrowUp" || event.key === backArrow ? -1 : 1;
            const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
            const adjacent = direction === -1 ? $from.nodeBefore : $from.nodeAfter;
            if (horizontal && adjacent?.type.name.startsWith("composer-")) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch(
                view.state.tr
                  .setSelection(
                    TextSelection.create(view.state.doc, $from.pos + direction * adjacent.nodeSize),
                  )
                  .scrollIntoView(),
              );
              return true;
            }
          }
          // Native tab order skips citation comment buttons inside the editor.
          if (
            event.key === "Tab" &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            view.state.selection.empty
          ) {
            const { $from } = view.state.selection;
            const citation = $from.nodeBefore;
            if (citation?.type.name === "composer-citation") {
              const chip = view.nodeDOM($from.pos - citation.nodeSize);
              const commentButton =
                chip instanceof HTMLElement
                  ? chip.querySelector<HTMLElement>("[data-citation-comment-trigger]")
                  : null;
              if (commentButton) {
                event.preventDefault();
                event.stopPropagation();
                commentButton.focus();
                return true;
              }
            }
          }
          if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
            event.stopPropagation();
            return true;
          }
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            return true;
          }
          if (
            richText &&
            !event.isComposing &&
            event.keyCode !== 229 &&
            view.state.selection.empty &&
            composerFormattingDelimiterForShortcut(event) === "**"
          ) {
            event.preventDefault();
            return true;
          }
          if (handleComposerSourceKey(view, event)) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
          const handler = onCommandKeyDownRef.current;
          if (event.key === "Enter") {
            const handled = handler?.("Enter", event) ?? false;
            if (handled) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
            event.preventDefault();
            return splitBlockKeepMarks(view.state, (tr) => {
              view.dispatch(tr.scrollIntoView());
            });
          }
          if (!handler) return false;
          const handled = handler(event.key, event);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
          return handled;
        },
        handleTextInput: (view, from, to, text) => {
          if (literalText || view.composing || text.length !== 1) return false;
          const closer = SURROUND_CLOSE[text];
          const { selection } = view.state;
          // Compose preedit updates replace a range even without a user selection.
          if (
            !closer ||
            !(selection instanceof TextSelection) ||
            selection.empty ||
            selection.from !== from ||
            selection.to !== to
          ) {
            return false;
          }
          // Typing over a chip replaces it; formatting shortcuts can wrap chips explicitly.
          let touchesSpecial = false;
          view.state.doc.nodesBetween(from, to, (node) => {
            if (node.isAtom && node.isInline && !node.isText) {
              touchesSpecial = true;
              return false;
            }
            return true;
          });
          if (touchesSpecial) return false;
          const map = serializeEditorDoc(view.state.doc);
          const startMd = flatToMarkdown(map, pmToFlat(map, from));
          const endMd = flatToMarkdown(map, pmToFlat(map, to));
          if (selectionTouchesMentionBoundary(map.value, startMd, endMd)) return false;
          return wrapComposerSourceSelection(view, from, to, text, closer);
        },
        handlePaste: (view, event) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData || clipboardData.files.length > 0) return false;
          const pastedText = clipboardData.getData("text/plain");
          if (!pastedText) return false;
          event.preventDefault();
          if (handleComposerSourcePaste(view, pastedText)) return true;
          const importFragment = importFragmentRef.current;
          let text =
            !literalText && importFragment
              ? importPastedComposerText(clipboardData, importFragment)
              : pastedText;
          const tokens = literalText ? [] : collectComposerPromptInlineTokens(`${text}\n`);
          const isChip = (token: (typeof tokens)[number] | undefined) =>
            token?.type === "mention" ||
            (token?.type === "skill" && skillLabelFor(token.value) !== null);
          const lastToken = tokens.at(-1);
          if (isChip(lastToken) && lastToken?.end === text.length) {
            text += " ";
          }
          if (isChip(tokens[0]) && tokens[0]?.start === 0) {
            const map = serializeEditorDoc(view.state.doc);
            const offset = flatToMarkdown(map, pmToFlat(map, view.state.selection.from));
            if (offset > 0 && !/\s/.test(map.value[offset - 1]!)) text = ` ${text}`;
          }
          const { $from } = view.state.selection;
          const lineBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\uFFFC");
          const literalLength = literalText
            ? 0
            : pastedPathQueryLength(lineBefore, text, isPathQueryActiveRef.current?.());
          const editorInstance = editorHolder.current;
          if (editorInstance) {
            insertMarkdownParagraphs(
              text,
              skillLabelFor,
              {
                styling: composerLivePreviewKey.getState(view.state)?.enabled ?? false,
                literalText,
                literalLength,
              },
              (content) => {
                editorInstance
                  .chain()
                  .command(({ tr }) => {
                    markAsClipboardEdit(tr, "paste");
                    return true;
                  })
                  .insertContent(content)
                  .run();
              },
            );
            scrollTiptapCaretIntoView(editorInstance);
          }
          return true;
        },
      },
      onTransaction: ({ editor: updated, transaction }) => {
        const meta = transaction.getMeta(composerLivePreviewKey) as
          | { composing?: boolean }
          | undefined;
        if (meta?.composing === false) handleEditorChange(updated, true);
      },
      onUpdate: ({ editor: updated, transaction }) => {
        if (!literalText && isHistoryTransaction(transaction)) {
          const stale = skillChipReplacements(updated.state.doc, skillLabelFor).filter(
            ({ node }) => node.isText,
          );
          if (stale.length > 0) {
            replaceSkillChips(updated, stale);
            return;
          }
        }
        handleEditorChange(updated);
      },
      onSelectionUpdate: ({ editor: updated }) => {
        handleEditorChange(updated);
      },
    },
    [],
  );

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    editorHolder.current = editor;
  }, [editor]);

  useLayoutEffect(() => {
    if (!editor) return;
    const current = composerLivePreviewKey.getState(editor.state);
    if (current?.enabled === richText && current.editable === !disabled) return;
    editor.view.dispatch(
      editor.state.tr
        .setMeta(composerLivePreviewKey, { enabled: richText, editable: !disabled })
        .setMeta("addToHistory", false),
    );
  }, [disabled, editor, richText]);

  // Push attributes before layout measurements; Tiptap updates them later in a passive effect.
  useLayoutEffect(() => {
    if (!editor?.isInitialized) return;
    editor.view.setProps({ attributes: editorAttributes });
  }, [editor, editorAttributes]);

  const readSnapshot = () => {
    const snapshot = snapshotRef.current;
    if (!editor) return snapshot;
    const map = serializeEditorDoc(editor.state.doc);
    const { from, to } = editor.state.selection;
    const position = resolveComposerSourcePosition(map, { document: from });
    const next: typeof snapshot = {
      value: map.value,
      cursor: position.flat,
      expandedCursor: position.source,
      contextIds: literalText ? [] : map.contextIds,
    };
    const toFlat = pmToFlat(map, to);
    selectionRangeRef.current = {
      start: Math.min(next.expandedCursor, flatToMarkdown(map, toFlat)),
      end: Math.max(next.expandedCursor, flatToMarkdown(map, toFlat)),
    };
    snapshotRef.current = next;
    return next;
  };

  // Save citation drafts before controlled rewrites unmount their node views.
  const saveCitationDraft = useEffectEvent((current: TiptapEditor, replacedValue: string) => {
    const draft = citationDraftRef.current;
    citationDraftRef.current = null;
    if (!draft || !onCitationDraftSave) return;
    const [target] = findChildren(
      current.state.doc,
      (node) => node.type.name === "composer-citation" && node.attrs.citeKey === draft.key,
    );
    if (!target) return;
    const { node, pos } = target;
    const citation = node.attrs.citation as AssistantCitation;
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason: "none",
      draft: draft.comment,
      savedComment: citation.comment,
    });
    if (dismissal.kind !== "commit") return;
    const next = withAssistantCitationComment(citation, dismissal.comment);
    current.view.dispatch(
      current.state.tr
        .setNodeMarkup(pos, undefined, {
          ...node.attrs,
          citation: next,
          source: serializeAssistantCitation(next),
        })
        .setMeta("addToHistory", false),
    );
    onCitationDraftSave(replacedValue, serializeEditorDoc(current.state.doc).value);
  });

  useLayoutEffect(() => {
    if (!editor) return;
    const initialSelection = !hasAppliedControlledSelectionRef.current;
    hasAppliedControlledSelectionRef.current = true;
    const requestedSourceCursor = clampEditorCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    if (
      !initialSelection &&
      previousSnapshot.value === value &&
      previousSnapshot.expandedCursor === requestedSourceCursor
    ) {
      return;
    }
    setIsEmpty(value.length === 0);
    const rootElement = editor.view.dom;
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (!initialSelection && previousSnapshot.value === value && !isFocused) return;

    isApplyingControlledUpdateRef.current = true;
    const pendingCitation =
      citationRequestRef.current?.value === value ? citationRequestRef.current : null;
    if (previousSnapshot.value !== value) {
      saveCitationDraft(editor, previousSnapshot.value);
      editor.commands.setContent(
        buildDocJson(value, skillLabelFor, { styling: richText, literalText }),
        {
          emitUpdate: false,
        },
      );
    }
    const map = serializeEditorDoc(editor.state.doc);
    const {
      flat,
      source: expandedCursor,
      document: documentPosition,
    } = resolveComposerSourcePosition(map, { source: requestedSourceCursor });
    snapshotRef.current = {
      value: map.value,
      cursor: flat,
      expandedCursor,
      contextIds: literalText ? [] : map.contextIds,
    };
    selectionRangeRef.current = { start: expandedCursor, end: expandedCursor };
    editor.commands.setTextSelection(documentPosition);
    if (isFocused) scrollTiptapCaretIntoView(editor);
    if (pendingCitation) {
      citationRequestRef.current = null;
      const target = map.runs.find(
        (run) =>
          run.kind === "token" &&
          run.nodeName === "composer-citation" &&
          run.mdStart === pendingCitation.citationStart,
      );
      if (target) {
        const node = editor.state.doc.nodeAt(target.pmPos);
        const citeKey = (node?.attrs as { citeKey?: string } | undefined)?.citeKey;
        if (citeKey) {
          setOpenCitation({
            key: citeKey,
            sourceAnchor: pendingCitation.sourceAnchor,
            removeOnCancel: pendingCitation.insertedSpaces,
          });
        }
      }
    }
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [clampEditorCursor, cursor, editor, literalText, richText, skillLabelFor, value]);

  // Reconcile loaded or switched provider skills without rebuilding citation node views.
  useEffect(() => {
    if (!editor || literalText) return;
    const replacements = skillChipReplacements(editor.state.doc, (name) =>
      composerSkillMeta(skills, name),
    );
    if (replacements.length > 0) replaceSkillChips(editor, replacements);
  }, [editor, literalText, skills]);

  useLayoutEffect(() => {
    if (!editor) return;
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      editor.view.focus();
      scrollTiptapCaretIntoView(editor);
    }
    return () => {
      // Capture focus before the keyed editor's DOM is removed.
      restoreFocusRef.current = editor.view.hasFocus();
    };
  }, [editor, restoreFocusRef]);

  const focusAt = (nextCursor: number) => {
    if (!editor) return;
    // view.focus() writes selection immediately; bare DOM focus waits 20ms and can misplace fast dictation.
    editor.view.focus();
    // A newer prompt is waiting to be applied (a chip was just inserted
    // through the store). Reporting the editor's stale text now would
    // overwrite that prompt; the pending rewrite places the caret instead.
    if (snapshotRef.current.value !== latestValueRef.current) return;
    const map = serializeEditorDoc(editor.state.doc);
    const sourceCursor = clampEditorCursor(map.value, nextCursor);
    const {
      flat,
      source: expandedCursor,
      document: documentPosition,
    } = resolveComposerSourcePosition(map, { source: sourceCursor });
    editor.commands.setTextSelection(documentPosition);
    scrollTiptapCaretIntoView(editor);
    if (expandedCursor === snapshotRef.current.expandedCursor) return;
    snapshotRef.current = {
      value: snapshotRef.current.value,
      cursor: flat,
      expandedCursor,
      contextIds: snapshotRef.current.contextIds,
    };
    selectionRangeRef.current = {
      start: snapshotRef.current.expandedCursor,
      end: snapshotRef.current.expandedCursor,
    };
    onChangeRef.current(
      snapshotRef.current.value,
      flat,
      snapshotRef.current.expandedCursor,
      literalText,
      snapshotRef.current.contextIds,
    );
  };

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        focusAt(readSnapshot().expandedCursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(readSnapshot().value.length);
      },
      readSelectionRange: () => {
        readSnapshot();
        return selectionRangeRef.current;
      },
      requestCitationComment: (request) => {
        citationRequestRef.current = request;
        if (!editor) return;
        const map = serializeEditorDoc(editor.state.doc);
        if (map.value !== request.value) return;
        const target = map.runs.find(
          (run) =>
            run.kind === "token" &&
            run.nodeName === "composer-citation" &&
            run.mdStart === request.citationStart,
        );
        if (!target) return;
        const node = editor.state.doc.nodeAt(target.pmPos);
        const citeKey = (node?.attrs as { citeKey?: string } | undefined)?.citeKey;
        if (citeKey) {
          citationRequestRef.current = null;
          setOpenCitation({
            key: citeKey,
            sourceAnchor: request.sourceAnchor,
            removeOnCancel: request.insertedSpaces,
          });
        }
      },
      readSnapshot,
      isCaretOnVisualEdge: (edge) => {
        const snapshot = readSnapshot();
        if (snapshot.value.length === 0) return true;
        const beforeCaret = snapshot.value.slice(0, snapshot.expandedCursor);
        const afterCaret = snapshot.value.slice(snapshot.expandedCursor);
        if (edge === "start" ? beforeCaret.includes("\n") : afterCaret.includes("\n")) {
          return false;
        }
        const rootElement = editor?.view.dom;
        const selection = window.getSelection();
        if (
          !rootElement ||
          !selection ||
          !selection.isCollapsed ||
          selection.rangeCount === 0 ||
          !selection.anchorNode ||
          !rootElement.contains(selection.anchorNode)
        ) {
          return false;
        }
        const caretRect = caretLineRect(selection.getRangeAt(0), edge);
        if (!caretRect) return false;
        const edgeElement =
          edge === "start" ? rootElement.firstElementChild : rootElement.lastElementChild;
        const edgeRect = (edgeElement ?? rootElement).getBoundingClientRect();
        const threshold = caretRect.height / 2;
        return edge === "start"
          ? caretRect.top - edgeRect.top < threshold
          : edgeRect.bottom - caretRect.bottom < threshold;
      },
    }),
    [editor, focusAt, literalText, readSnapshot],
  );

  const handleCopyCut = (event: React.ClipboardEvent, cut: boolean) => {
    const build = buildFragmentRef.current;
    if (!editor || (cut && !editor.isEditable)) return;
    const clipboardData = event.clipboardData;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = serializeSelection(editor.state.doc, from, to);
    const contextIds = literalText ? [] : Array.from(new Set(collectInlineContextIds(text)));
    const fragment = contextIds.length > 0 ? build?.(contextIds) : null;
    event.preventDefault();
    clipboardData.setData("text/plain", text);
    if (fragment) {
      clipboardData.setData(COMPOSER_CONTEXT_CLIPBOARD_MIME, fragment);
      clipboardData.setData("text/html", encodeComposerContextClipboardHtml(text, fragment));
    }
    if (cut) {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          markAsClipboardEdit(tr, "cut");
          return true;
        })
        .deleteSelection()
        .run();
    }
  };

  return (
    <RichComposerSkillsContext value={skills}>
      <ComposerContextRecordsContext value={contextRecords}>
        <ComposerCitationCommentContext value={citationCommentActions}>
          <div
            className={cn(
              "relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)",
              containerClassName,
            )}
          >
            <EditorContent
              editor={editor}
              onKeyDown={(event) => {
                if (
                  event.key === "Control" ||
                  event.key === "Meta" ||
                  event.key === "Alt" ||
                  event.key === "Shift"
                ) {
                  onPageScrollRelease?.();
                }
                if (event.key !== "PageUp" && event.key !== "PageDown") return;
                const target = event.currentTarget.querySelector(
                  '[data-testid="composer-editor"]',
                ) as HTMLElement | null;
                if (!target) return;
                const pageScrollKey = getTimelinePageScrollKey({
                  altKey: event.altKey,
                  clientHeight: target.clientHeight,
                  ctrlKey: event.ctrlKey,
                  defaultPrevented: event.defaultPrevented,
                  isComposing: event.nativeEvent.isComposing,
                  key: event.key,
                  keyCode: event.keyCode,
                  metaKey: event.metaKey,
                  scrollHeight: target.scrollHeight,
                  scrollTop: target.scrollTop,
                  shiftKey: event.shiftKey,
                });
                if (!pageScrollKey) {
                  onPageScrollRelease?.();
                  return;
                }
                if (!onPageScrollKeyDown) return;
                event.preventDefault();
                onPageScrollKeyDown(pageScrollKey);
              }}
              onKeyUp={(event) => onPageScrollKeyUp?.(event.key)}
              onBlur={onPageScrollRelease}
              onPasteCapture={onPaste}
              onCopyCapture={(event) => handleCopyCut(event, false)}
              onCutCapture={(event) => handleCopyCut(event, true)}
            />
            {isEmpty && contextRecords.size === 0 && placeholder ? (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 leading-relaxed text-placeholder/75",
                  placeholderClassName,
                )}
              >
                {placeholder}
              </div>
            ) : null}
          </div>
        </ComposerCitationCommentContext>
      </ComposerContextRecordsContext>
    </RichComposerSkillsContext>
  );
}

/**
 * Insert pasted markdown at the selection, rebuilding inline tokens as chips
 * while keeping Markdown characters as text.
 *
 * Newlines always become paragraph splits — never trailing hard breaks, which
 * render no visible line — so pasted text lands exactly as typed.
 */
function insertMarkdownParagraphs(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options: { styling?: boolean; literalText?: boolean; literalLength?: number },
  insertContent: (content: JSONContent[] | JSONContent) => void,
): void {
  const blocks = buildTiptapContent(value, skillLabelFor, options);
  if (blocks.length === 1 && blocks[0]?.type === "paragraph") {
    const inline = (blocks[0]?.content ?? []) as JSONContent[];
    if (inline.length === 0) return;
    insertContent(inline);
    return;
  }
  insertContent(blocks as JSONContent[]);
}

/** Native scrolling follows only real input; explicitly reveal programmatically placed carets. */
function scrollTiptapCaretIntoView(editor: TiptapEditor): void {
  editor.view.dispatch(editor.state.tr.scrollIntoView());
}

function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const collapsedRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const collapsedRect = edge === "start" ? collapsedRects.at(-1) : collapsedRects[0];
  if (collapsedRect) return collapsedRect;

  const container = range.startContainer;
  if (container.nodeType === 3) {
    const textNode = container as Text;
    if (textNode.data.length === 0) return null;
    const probeStart = Math.max(
      0,
      Math.min(
        edge === "start" ? range.startOffset : range.startOffset - 1,
        textNode.data.length - 1,
      ),
    );
    const probeRange = document.createRange();
    probeRange.setStart(textNode, probeStart);
    probeRange.setEnd(textNode, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
    const boundingRect = probeRange.getBoundingClientRect();
    return boundingRect.height > 0 ? boundingRect : null;
  }

  if (!(container instanceof HTMLElement)) return null;
  const neighbour =
    container.childNodes[Math.max(0, range.startOffset - 1)] ??
    container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    const isBeforeCaret = neighbour === container.childNodes[range.startOffset - 1];
    const probeStart = isBeforeCaret ? neighbour.data.length - 1 : 0;
    const probeRange = document.createRange();
    probeRange.setStart(neighbour, probeStart);
    probeRange.setEnd(neighbour, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
  }
  const containerRect = container.getBoundingClientRect();
  return containerRect.height > 0 ? containerRect : null;
}
