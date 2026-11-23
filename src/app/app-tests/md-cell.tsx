"use client"

// Markdown cell for test steps: shows rendered markdown that grows with its
// content; a click swaps in a Tiptap editor (markdown in and out). Only the cell
// being edited holds an editor, so large grids stay light.

import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Markdown } from "@tiptap/markdown"
import Placeholder from "@tiptap/extension-placeholder"
import { cn } from "@/lib/utils"

// Plain-text steps (Azure CSV) use single newlines as line breaks; keep them.
const withBreaks = (md: string) => md.replace(/([^\n])\n(?!\n)/g, "$1  \n")

const BOX = "composer-editor w-full min-w-0 rounded-md border px-1.5 py-1 text-xs leading-relaxed break-words"

function Editor({
  value,
  placeholder,
  onDone,
}: {
  value: string
  placeholder?: string
  onDone: (md: string) => void
}) {
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })
  const finish = (md: string) => done.current(md.trim())

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    autofocus: "end",
    content: withBreaks(value),
    contentType: "markdown",
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      Markdown,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    editorProps: {
      attributes: { class: cn(BOX, "selectable border-ring bg-background outline-none") },
      handleKeyDown: (view, e) => {
        if (e.key === "Escape") {
          ;(view.dom as HTMLElement).blur()
          return true
        }
        return false
      },
    },
    onCreate: ({ editor }) => {
      // Keep text as typed: the stock encoder escapes `<`, `_` and friends.
      const manager = editor.markdown as unknown as { encodeTextForMarkdown?: (text: string) => string } | undefined
      if (manager) manager.encodeTextForMarkdown = (text) => text
    },
    onBlur: ({ editor }) => finish(editor.getMarkdown()),
  })

  return <EditorContent editor={editor} />
}

export function MdCell({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (md: string) => void
  placeholder?: string
  className?: string
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <div className={className}>
        <Editor
          value={value}
          placeholder={placeholder}
          onDone={(md) => {
            setEditing(false)
            if (md !== value.trim()) onChange(md)
          }}
        />
      </div>
    )
  }

  return (
    <div
      role="textbox"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onFocus={() => setEditing(true)}
      className={cn(BOX, "cursor-text border-transparent hover:border-input", className)}
    >
      {value.trim() ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{withBreaks(value)}</ReactMarkdown>
      ) : (
        <span className="text-muted-foreground">{placeholder}</span>
      )}
    </div>
  )
}
