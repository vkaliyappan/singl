import { useCallback, useRef, useState } from "react";
import type { FlowGraph } from "@/lib/twx-flow/types";

const MAX_HISTORY = 40;

export function useFlowHistory(initialGraph: FlowGraph) {
  const [graph, setGraphState] = useState<FlowGraph>(initialGraph);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const past = useRef<FlowGraph[]>([]);
  const future = useRef<FlowGraph[]>([]);
  const current = useRef<FlowGraph>(initialGraph);

  const syncFlags = useCallback(() => {
    setCanUndo(past.current.length > 0);
    setCanRedo(future.current.length > 0);
  }, []);

  /**
   * Mutate the graph and record the previous state into history.
   * `recordHistory = false` is used for continuous interactions (e.g. active dragging)
   * where snapshotting every intermediate frame is unwanted.
   */
  const setGraph = useCallback(
    (
      updater: FlowGraph | ((prev: FlowGraph) => FlowGraph),
      recordHistory = true
    ) => {
      const next = typeof updater === "function" ? updater(current.current) : updater;
      if (next === current.current) return;

      if (recordHistory) {
        past.current = [...past.current.slice(-(MAX_HISTORY - 1)), current.current];
        future.current = [];
      }

      current.current = next;
      setGraphState(next);
      syncFlags();
    },
    [syncFlags]
  );

  /**
   * Explicitly commit a state snapshot to history (e.g. on pointerUp after a drag).
   */
  const commitSnapshot = useCallback((snapshot: FlowGraph) => {
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), snapshot];
    future.current = [];
    syncFlags();
  }, [syncFlags]);

  const undo = useCallback((): FlowGraph | null => {
    if (past.current.length === 0) return null;
    const previous = past.current[past.current.length - 1];
    past.current = past.current.slice(0, -1);
    future.current = [current.current, ...future.current.slice(0, MAX_HISTORY - 1)];
    current.current = previous;
    setGraphState(previous);
    syncFlags();
    return previous;
  }, [syncFlags]);

  const redo = useCallback((): FlowGraph | null => {
    if (future.current.length === 0) return null;
    const next = future.current[0];
    future.current = future.current.slice(1);
    past.current = [...past.current.slice(-(MAX_HISTORY - 1)), current.current];
    current.current = next;
    setGraphState(next);
    syncFlags();
    return next;
  }, [syncFlags]);

  const resetHistory = useCallback((newGraph: FlowGraph) => {
    past.current = [];
    future.current = [];
    current.current = newGraph;
    setGraphState(newGraph);
    syncFlags();
  }, [syncFlags]);

  return {
    graph,
    setGraph,
    commitSnapshot,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
  };
}

