"use client";

import { Component, type ReactNode } from "react";
import { DiffView } from "../diff-view";
import { isRecord } from "../shared";
import { asDataShapeFields, asDataShapeMap, DataShapeView } from "./datashape";
import { asInfoTable, InfoTableView } from "./infotable";
import { asProperties, isVtq, PropertyPanel } from "./property-panel";
import { RunTimesView } from "./run-times";
import { asServiceDefs, ServiceSignatures } from "./service-signature";
import * as sv from "./server-views";

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
    case "twx_query_logs": {
      const rows = sv.asLogRows(value);
      return rows ? <sv.LogsView rows={rows} /> : null;
    }
    case "twx_query_datatable":
    case "twx_query_stream": {
      const r = sv.asQueryResult(value);
      return r ? <sv.QueryResultView value={r} id={name} /> : null;
    }
    case "twx_list_streams":
      return isRecord(value) && Array.isArray(value.streams) ? <sv.StreamListView value={value} /> : null;
    case "twx_list_datatables":
      return Array.isArray(value) && value.length && value.every(isRecord) ? <sv.NamedListView rows={value} id={name} /> : null;
    case "twx_list_connectors":
      return Array.isArray(value) && value.length && value.every(isRecord) ? <sv.ConnectorsView rows={value} /> : null;
    case "twx_list_subscriptions":
      return Array.isArray(value) && value.length && value.every(isRecord) ? <sv.SubscriptionsView rows={value} /> : null;
    case "twx_list_schedulers":
      return Array.isArray(value) && value.length && value.every(isRecord) ? <sv.SchedulersView rows={value} /> : null;
    case "twx_server_health": {
      const h = sv.asHealth(value);
      return h ? <sv.HealthView ping={h.ping} health={h.health} /> : null;
    }
    case "twx_entity_permissions": {
      const p = sv.asPermissions(value);
      return p ? <sv.PermissionsView value={p} /> : null;
    }
    case "twx_check_permission": {
      const d = sv.asDecision(value);
      return d ? <sv.VerdictView value={d} /> : null;
    }
    case "twx_import_preview": {
      const items = sv.asImportItems(value);
      return items ? <sv.ImportItemsView items={items} /> : null;
    }
    case "twx_import_entities": {
      if (!isRecord(value)) return null;
      const env = typeof value.environment === "string" ? value.environment : "";
      if (value.dryRun === true) {
        const items = sv.asImportItems(value.files);
        return items ? <sv.ImportItemsView items={items} note={`Dry run on ${env}`} /> : null;
      }
      return isRecord(value.result) && Array.isArray(value.result.results) ? <sv.ImportResultView env={env} result={value.result} /> : null;
    }
    case "entity_dependencies": {
      const g = sv.asDepGraph(value);
      return g ? <sv.DepGraphView graph={g} /> : null;
    }
    case "entity_service_callers": {
      const c = sv.asCallers(value);
      return c ? <sv.CallersView value={c} /> : null;
    }
    case "entity_unused": {
      const u = sv.asDepNodes(value);
      return u ? <sv.UnusedView value={u} /> : null;
    }
    case "automation_run_suite": {
      const r = sv.asSuiteRun(value);
      return r ? <sv.SuiteRunView value={r} /> : null;
    }
    case "automation_drift_report": {
      const d = sv.asDrift(value);
      return d ? <sv.DriftView value={d} /> : null;
    }
    case "entity_undo_list": {
      const rows = sv.asUndoList(value);
      return rows ? <sv.UndoListView rows={rows} /> : null;
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
