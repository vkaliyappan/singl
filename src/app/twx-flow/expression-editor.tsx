"use client";

import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as placeholderExt,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

import { cn } from "@/lib/utils";
import { evaluateExpression, type ExprContext } from "@/lib/twx-flow/expression";
import { EXPRESSION_MIME } from "./schema-tree";

/** What a parent needs from a mounted editor: the caret, and a way to write at it. */
export type ExpressionEditorHandle = {
  focus: () => void;
  /** Writes at the caret, replacing the selection, the way a paste would. */
  insert: (text: string) => void;
};

/**
 * Recomputed decorations depend on the evaluation context as well as the text —
 * a wire added upstream can turn a red expression green without a keystroke.
 * This effect is how a context change asks for a fresh pass.
 */
const refreshContext = StateEffect.define<null>();

const TEMPLATE = /\{\{[\s\S]*?\}\}/g;

// Plain Tailwind classes rather than a CodeMirror theme, so these track the
// palette the rest of the panel is using.
const okMark = Decoration.mark({ class: "rounded bg-primary/15 text-primary" });
const brokenMark = Decoration.mark({
  class: "rounded bg-destructive/15 text-destructive underline decoration-wavy decoration-destructive/60",
});

/** Marks every `{{ … }}` block, red if it cannot be evaluated as it stands. */
function templateMarks(text: string, ctx: ExprContext): DecorationSet {
  const ranges = [];
  TEMPLATE.lastIndex = 0;
  for (let match = TEMPLATE.exec(text); match; match = TEMPLATE.exec(text)) {
    let broken = false;
    try {
      evaluateExpression(match[0].slice(2, -2), ctx);
    } catch {
      broken = true;
    }
    ranges.push((broken ? brokenMark : okMark).range(match.index, match.index + match[0].length));
  }
  return Decoration.set(ranges);
}

/** The highlighter, reading the latest context through a ref rather than a facet. */
function highlightTemplates(ctxRef: RefObject<ExprContext>): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = templateMarks(view.state.doc.toString(), ctxRef.current);
      }

      update(update: ViewUpdate) {
        const contextChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshContext))
        );
        if (update.docChanged || contextChanged) {
          this.decorations = templateMarks(update.state.doc.toString(), ctxRef.current);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}

/**
 * Metrics only. Colours stay in Tailwind classes above and on the wrapper, so
 * this one theme is right in both light and dark mode.
 */
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "11px",
    lineHeight: "1.5",
    maxHeight: "220px",
  },
  ".cm-content": { padding: "6px 8px", minHeight: "20px", caretColor: "currentColor" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
});

/**
 * The expression editor: plain text with `{{ … }}` picked out, on CodeMirror.
 *
 * It replaced a transparent textarea laid over a highlighted `<pre>`, which had
 * to keep two elements in step down to the pixel and lost the alignment on
 * wrapped lines and on scroll. CodeMirror draws the text once and decorates it
 * in place, so there is nothing left to keep in step.
 *
 * The value is a string in and a string out — the surrounding field, its Fixed /
 * Expression switch and its evaluated-result panel all work as they did.
 */
export function ExpressionEditor({
  ref,
  value,
  ctx,
  placeholder,
  className,
  onChange,
  onDropSnippet,
}: {
  ref?: RefObject<ExpressionEditorHandle | null>;
  value: string;
  ctx: ExprContext;
  placeholder?: string;
  className?: string;
  onChange: (value: string) => void;
  /** Told after a schema row was dropped in, so the parent can drop its highlight. */
  onDropSnippet?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // What the editor is built with. CodeMirror owns its document after that, so
  // these are captured once and the effect below stays a mount-only one.
  const [initialDoc] = useState(value);
  const [initialPlaceholder] = useState(placeholder ?? "");

  // Everything the extensions need to read at event time. Extensions are built
  // once; refs are how they see the current render's props.
  const ctxRef = useRef(ctx);
  const onChangeRef = useRef(onChange);
  const onDropRef = useRef(onDropSnippet);

  // Declared before the effect that builds the editor, so an extension never
  // reads a prop a render behind.
  useEffect(() => {
    ctxRef.current = ctx;
    onChangeRef.current = onChange;
    onDropRef.current = onDropSnippet;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const editor = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          highlightTemplates(ctxRef),
          editorTheme,
          placeholderExt(initialPlaceholder),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          // A schema row carries `text/plain` too, so CodeMirror's own drop
          // handler would insert it as well as the panel's. Taking the event
          // here means one insert, and it lands where the pointer is rather
          // than wherever the caret happened to be.
          EditorView.domEventHandlers({
            drop(event, dropView) {
              const snippet = event.dataTransfer?.getData(EXPRESSION_MIME);
              if (!snippet) return false;
              event.preventDefault();
              event.stopPropagation();
              const at =
                dropView.posAtCoords({ x: event.clientX, y: event.clientY }) ??
                dropView.state.doc.length;
              dropView.dispatch({
                changes: { from: at, insert: snippet },
                selection: { anchor: at + snippet.length },
              });
              dropView.focus();
              onDropRef.current?.();
              return true;
            },
          }),
        ],
      }),
      parent,
    });

    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [initialDoc, initialPlaceholder]);

  // Someone else changed the value — the Clear button, a mode switch, a drop
  // onto a different field. Anything the editor itself typed is already here.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: refreshContext.of(null) });
  }, [ctx]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      insert: (text: string) => {
        const editor = view.current;
        if (!editor) return;
        const { from, to } = editor.state.selection.main;
        editor.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          scrollIntoView: true,
        });
        editor.focus();
      },
    }),
    []
  );

  return (
    <div ref={host} className={cn("min-h-8 overflow-hidden", className)} />
  );
}
