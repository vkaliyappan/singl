"use client";

// The composer's rich-text box: Tiptap with markdown in and out. Markdown
// shortcuts (`**bold**`, `- list`, ``` fences, `# heading`) format as you
// type; what is sent is the message as markdown.

import { useEffect, useRef } from "react";
import {
  EditorContent,
  mergeAttributes,
  Node,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";

export { EditorContent };

/**
 * An attached file or pinned item named inline as an `@name` badge. `ref`
 * ties it to its chip above the box (see the Composer's sync); it is sent as
 * plain `@name`.
 */
const MentionChip = Node.create({
  name: "mentionChip",
  group: "inline",
  inline: true,
  atom: true,
  // Drag a badge to move it anywhere in the text.
  draggable: true,
  addAttributes() {
    return {
      ref: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-ref") ?? "",
        renderHTML: (a) => ({ "data-ref": a.ref }),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (a) => ({ "data-label": a.label, title: a.label }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention-chip]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention-chip": "",
        class:
          // Not truncate/overflow-hidden: that moves an inline-block's baseline to
          // its bottom edge. `!` beats ProseMirror's white-space:normal on atoms.
          "mx-px inline-block cursor-grab rounded-md bg-primary/10 px-1.5 leading-normal font-medium whitespace-nowrap! text-primary active:cursor-grabbing",
      }),
      `@${node.attrs.label}`,
    ];
  },
  renderText: ({ node }) => `@${node.attrs.label}`,
  renderMarkdown: (node) => `@${node.attrs?.label ?? ""}`,
});

/** Puts an `@name` badge at the caret (at the end if the box is not focused). */
export function insertMention(editor: Editor, ref: string, label: string) {
  const chain = editor.isFocused ? editor.chain() : editor.chain().focus("end");
  chain
    .insertContent([
      { type: MentionChip.name, attrs: { ref, label } },
      { type: "text", text: " " },
    ])
    .run();
}

/** The `ref`s of the badges in the box. */
export function mentionRefs(editor: Editor): Set<string> {
  const refs = new Set<string>();
  editor.state.doc.descendants((n) => {
    if (n.type.name === MentionChip.name) refs.add(n.attrs.ref);
  });
  return refs;
}

/** Deletes the badges for these refs. */
export function removeMentions(editor: Editor, refs: string[]) {
  if (!refs.length) return;
  const gone = new Set(refs);
  const at: number[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === MentionChip.name && gone.has(n.attrs.ref)) at.push(pos);
  });
  if (!at.length) return;
  const tr = editor.state.tr;
  for (const pos of at.reverse()) tr.delete(pos, pos + 1);
  editor.view.dispatch(tr);
}

type Handlers = {
  /** True when the key was handled (the editor then ignores it). */
  onKeyDown: (e: KeyboardEvent) => boolean;
  /** True when the paste was handled. */
  onPaste: (e: ClipboardEvent) => boolean;
};

export function useComposerEditor({
  placeholder,
  ...handlers
}: Handlers & { placeholder: string }) {
  // Handlers change every render; the editor is built once and reads the latest.
  const latest = useRef(handlers);
  const placeholderRef = useRef(placeholder);
  useEffect(() => {
    latest.current = handlers;
  });

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // A click in the box must not navigate the app's webview.
        link: { openOnClick: false, autolink: true },
      }),
      Markdown,
      MentionChip,
      // A function, read on every redraw: the options object the plugin saw is fixed at creation.
      // eslint-disable-next-line react-hooks/refs -- ProseMirror calls this when drawing, not React's render
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    editorProps: {
      attributes: {
        "aria-label": "Message the assistant",
        "aria-multiline": "true",
        class:
          "composer-editor selectable max-h-60 min-h-12 w-full overflow-y-auto px-4 pt-3.5 pb-1 text-[13px] leading-relaxed outline-none",
      },
      handleKeyDown: (_view, e) => latest.current.onKeyDown(e),
      handlePaste: (_view, e) => latest.current.onPaste(e),
    },
    onCreate: ({ editor }) => {
      // The markdown goes to a model, not back into a markdown parser: send
      // text as typed. The stock encoder would turn `my_var` into `my\_var`
      // and `a < b` into `a &lt; b`. (Private method; versions are pinned.)
      const manager = editor.markdown as unknown as
        | { encodeTextForMarkdown?: (text: string) => string }
        | undefined;
      if (manager) manager.encodeTextForMarkdown = (text) => text;
    },
  });

  const empty = useEditorState({
    editor,
    selector: ({ editor }) => !editor || !editor.getText().trim(),
  });

  // New text shows on the next redraw; nudge one.
  useEffect(() => {
    if (placeholderRef.current === placeholder) return;
    placeholderRef.current = placeholder;
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, placeholder]);

  return { editor, empty: empty ?? true };
}

/**
 * Enter on a line that is just ```` ``` ```` or ```` ```lang ````: make it a
 * code block, as chat apps do. Tiptap's own rule only fires on a space.
 */
export function openFence(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const m = /^```([\w+#.-]*)\s*$/.exec($from.parent.textContent);
  if (!m) return false;
  return editor
    .chain()
    .command(({ tr }) => {
      tr.delete($from.start(), $from.end());
      return true;
    })
    .setCodeBlock(m[1] ? { language: m[1] } : undefined)
    .run();
}

/** Pasted text with a ``` fence goes in as markdown, so the fence becomes a code block. */
export function pasteMarkdown(editor: Editor, e: ClipboardEvent): boolean {
  if (editor.isActive("codeBlock")) return false;
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!/^\s*```/m.test(text)) return false;
  e.preventDefault();
  editor.commands.insertContent(text, { contentType: "markdown" });
  return true;
}

/** The message as markdown, trimmed. */
export function editorMarkdown(editor: Editor | null): string {
  return editor ? editor.getMarkdown().trim() : "";
}

/** Puts markdown back in the box (a send that failed). */
export function setEditorMarkdown(editor: Editor | null, md: string) {
  if (!editor) return;
  editor.commands.setContent(md, { contentType: "markdown" });
  editor.commands.focus("end");
}
