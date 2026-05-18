"use client";

import { useState, useRef, useCallback } from "react";
import {
  IconSearch,
  IconChevronRight,
  IconX,
} from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { FileIcon } from "@/components/file-tree";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface SearchMatch {
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileResult {
  filePath: string;
  matches: SearchMatch[];
  filenameMatch?: boolean;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  matchFilename: boolean;
}

interface SearchPanelProps {
  onSearch: (query: string, options: SearchOptions) => Promise<SearchFileResult[]>;
  onResultClick: (filePath: string, lineNumber: number, matchStart: number) => void;
}

function HighlightedLine({
  content,
  matchStart,
  matchEnd,
}: {
  content: string;
  matchStart: number;
  matchEnd: number;
}) {
  const trimmedStart = content.length - content.trimStart().length;
  const displayContent = content.trimStart();
  const adjStart = Math.max(0, matchStart - trimmedStart);
  const adjEnd = Math.max(adjStart, matchEnd - trimmedStart);
  const before = displayContent.slice(0, adjStart);
  const match = displayContent.slice(adjStart, adjEnd);
  const after = displayContent.slice(adjEnd);
  return (
    <span>
      {before}
      <mark className="bg-yellow-200 dark:bg-yellow-700/60 text-inherit rounded-[2px] px-px">
        {match}
      </mark>
      {after}
    </span>
  );
}

function ToggleButton({
  active,
  title,
  children,
  onClick,
}: {
  active: boolean;
  title: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "h-5 w-5 flex items-center justify-center rounded text-[10px] font-mono font-bold transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      )}
    >
      {children}
    </button>
  );
}

export function SearchPanel({ onSearch, onResultClick }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchFilename, setMatchFilename] = useState(false);
  const [results, setResults] = useState<SearchFileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    async (q: string, opts: SearchOptions) => {
      if (!q.trim()) {
        setResults([]);
        setSearchedFor(null);
        setError(null);
        return;
      }
      setSearching(true);
      setError(null);
      try {
        const r = await onSearch(q, opts);
        setResults(r);
        setSearchedFor(q);
        setCollapsedFiles(new Set());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [onSearch]
  );

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(value, { caseSensitive, wholeWord, useRegex, matchFilename });
    }, 400);
  };

  const handleOptionToggle = (opt: "case" | "word" | "regex" | "filename") => {
    const nc = opt === "case" ? !caseSensitive : caseSensitive;
    const nw = opt === "word" ? !wholeWord : wholeWord;
    const nr = opt === "regex" ? !useRegex : useRegex;
    const nf = opt === "filename" ? !matchFilename : matchFilename;
    if (opt === "case") setCaseSensitive(nc);
    if (opt === "word") setWholeWord(nw);
    if (opt === "regex") setUseRegex(nr);
    if (opt === "filename") setMatchFilename(nf);
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      runSearch(query, { caseSensitive: nc, wholeWord: nw, useRegex: nr, matchFilename: nf });
    }
  };

  const toggleFile = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const totalMatches = results.reduce((s, r) => s + (r.matches.length || (r.filenameMatch ? 1 : 0)), 0);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Input row */}
      <div className="shrink-0 px-2 pt-2 pb-1.5 border-b flex flex-col gap-1">
        <div className="relative flex items-center">
          <IconSearch className="absolute left-2 size-3 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                runSearch(query, { caseSensitive, wholeWord, useRegex, matchFilename });
              }
              if (e.key === "Escape") {
                setQuery("");
                setResults([]);
                setSearchedFor(null);
              }
            }}
            placeholder="Search files…"
            className="h-7 text-xs pl-6 pr-2 font-mono"
            autoFocus
          />
          {query && (
            <button
              onClick={() => { setQuery(""); setResults([]); setSearchedFor(null); }}
              className="absolute right-1.5 text-muted-foreground hover:text-foreground"
            >
              <IconX className="size-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 px-0.5">
          <ToggleButton active={caseSensitive} title="Match Case" onClick={() => handleOptionToggle("case")}>
            Aa
          </ToggleButton>
          <ToggleButton active={wholeWord} title="Match Whole Word" onClick={() => handleOptionToggle("word")}>
            ab
          </ToggleButton>
          <ToggleButton active={useRegex} title="Use Regular Expression" onClick={() => handleOptionToggle("regex")}>
            .*
          </ToggleButton>
          <div className="w-px h-3 bg-border mx-0.5" />
          <ToggleButton active={matchFilename} title="Match Filename" onClick={() => handleOptionToggle("filename")}>
            fn
          </ToggleButton>
        </div>
      </div>

      {/* Results area */}
      <ScrollArea className="flex-1 min-h-0">
        {searching && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Searching…
          </div>
        )}

        {!searching && error && (
          <p className="text-xs text-destructive px-3 py-2">{error}</p>
        )}

        {!searching && !error && searchedFor && results.length === 0 && (
          <p className="text-xs text-muted-foreground px-3 py-3">
            No results for &ldquo;{searchedFor}&rdquo;
          </p>
        )}

        {!searching && results.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] text-muted-foreground select-none border-b">
              {totalMatches} result{totalMatches !== 1 ? "s" : ""} in {results.length} file{results.length !== 1 ? "s" : ""}
            </div>
            {results.map((fileResult) => {
              const collapsed = collapsedFiles.has(fileResult.filePath);
              const fileName = fileResult.filePath.split("/").pop() ?? fileResult.filePath;
              const dir = fileResult.filePath.includes("/")
                ? fileResult.filePath.slice(0, fileResult.filePath.lastIndexOf("/"))
                : "";
              return (
                <div key={fileResult.filePath}>
                  <button
                    onClick={() => toggleFile(fileResult.filePath)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-accent/40 transition-colors"
                  >
                    <IconChevronRight
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-100",
                        !collapsed && "rotate-90"
                      )}
                    />
                    <FileIcon name={fileName} className="size-3.5 shrink-0" />
                    <span className="text-xs font-medium truncate flex-1 min-w-0">{fileName}</span>
                    {dir && (
                      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[90px] shrink-0">
                        {dir}
                      </span>
                    )}
                    {fileResult.filenameMatch && fileResult.matches.length === 0 ? (
                      <span className="text-[10px] bg-muted text-muted-foreground rounded px-1 shrink-0 ml-1 italic">
                        name
                      </span>
                    ) : (
                      <span className="text-[10px] bg-muted text-muted-foreground rounded px-1 shrink-0 ml-1">
                        {fileResult.matches.length}
                      </span>
                    )}
                  </button>

                  {!collapsed && fileResult.filenameMatch && fileResult.matches.length === 0 && (
                    <button
                      onClick={() => onResultClick(fileResult.filePath, 1, 1)}
                      className="flex w-full items-center gap-1.5 py-[3px] pl-9 pr-2 text-left hover:bg-accent/60 transition-colors"
                    >
                      <span className="text-[11px] text-muted-foreground italic font-mono">— filename match</span>
                    </button>
                  )}

                  {!collapsed && fileResult.matches.length > 0 && fileResult.matches.map((match, i) => (
                    <button
                      key={i}
                      onClick={() =>
                        onResultClick(fileResult.filePath, match.lineNumber, match.matchStart + 1)
                      }
                      className="flex w-full items-start gap-1.5 py-[3px] pl-9 pr-2 text-left hover:bg-accent/60 transition-colors group"
                    >
                      <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-7 text-right leading-4">
                        {match.lineNumber}
                      </span>
                      <span className="text-[11px] text-muted-foreground group-hover:text-foreground truncate font-mono leading-4">
                        <HighlightedLine
                          content={match.lineContent}
                          matchStart={match.matchStart}
                          matchEnd={match.matchEnd}
                        />
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
