"use client";

import { Component, type ReactNode } from "react";
import { DiffView } from "../diff-view";
import { isRecord } from "../shared";
import { asDataShapeFields, asDataShapeMap, DataShapeView } from "./datashape";
import { asInfoTable, InfoTableView } from "./infotable";
import { asProperties, isVtq, PropertyPanel } from "./property-panel";
import { RunTimesView } from "./run-times";
import { asServiceDefs, ServiceSignatures } from "./service-signature";

class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function pick(name: string, input: unknown, value: unknown): ReactNode | null {
  const inp = isRecord(input) ? input : {};
  switch (name) {
    case "twx_invoke_service":
    case "service_execute": {
      if (asInfoTable(value)) return <InfoTableView value={value} />;
      const props = asProperties(value);
      if (props && Array.isArray(value) && isVtq(props)) return <PropertyPanel value={value} />;
      if (props && isRecord(value) && Array.isArray(value.rows) && isVtq(props)) return <PropertyPanel value={value} />;
      return null;
    }
    case "twx_get_property_values": {
      const pn = typeof inp.propertyName === "string" ? inp.propertyName : "";
      if (pn && (value === null || typeof value !== "object")) {
        return <PropertyPanel value={[{ name: pn, value }]} />;
      }
      return asProperties(value) ? <PropertyPanel value={value} /> : null;
    }
    case "twx_datashape_fields":
    case "flow_datashape_fields":
    case "twx_list_properties":
      return asDataShapeFields(value) || asDataShapeMap(value) ? <DataShapeView value={value} /> : null;
    case "service_definitions":
    case "twx_list_services":
      return asServiceDefs(value) ? <ServiceSignatures value={value} input={input} /> : null;
    case "entity_run_times":
      return isRecord(value) ? <RunTimesView value={value} /> : null;
    // repo_diff: { original, modified }; compare_content: { left: { content }, right: { content } } (repo vs export).
    case "repo_diff": {
      if (!isRecord(value) || typeof value.original !== "string" || typeof value.modified !== "string") return null;
      const file = typeof inp.file === "string" ? inp.file : undefined;
      return <DiffView original={value.original} modified={value.modified} path={file} />;
    }
    case "compare_content": {
      if (!isRecord(value) || !isRecord(value.left) || !isRecord(value.right)) return null;
      const side = (s: Record<string, unknown>) => (typeof s.content === "string" ? s.content : "");
      const path = typeof inp.path === "string" ? `${inp.path} (repository → export)` : undefined;
      return <DiffView original={side(value.left)} modified={side(value.right)} path={path} />;
    }
    default: {
      if (isRecord(value) && isRecord(value.dataShape)) {
        const t = asInfoTable(value);
        if (t && t.rows.length) return <InfoTableView value={value} />;
      }
      return null;
    }
  }
}

/** A rich view of a tool result, or null when unsure (caller falls back to raw JSON). Never throws. */
export function ToolResultView({
  name,
  input,
  content,
}: {
  name: string;
  input: unknown;
  content: string;
}): ReactNode | null {
  let node: ReactNode | null = null;
  try {
    node = pick(name, input, JSON.parse(content));
  } catch {
    node = null;
  }
  return node ? <Guard>{node}</Guard> : null;
}

export { InfoTableView, asInfoTable, PropertyPanel, asProperties, DataShapeView, asDataShapeFields, ServiceSignatures, RunTimesView };
export { PropsBlock } from "./property-panel";
