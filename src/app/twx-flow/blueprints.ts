import type { FlowGraph } from "@/lib/twx-flow/types";

export type BlueprintTemplate = {
  id: string;
  name: string;
  category: "Integration" | "ETL & Transform" | "Reconciliation" | "IoT & Telemetry";
  description: string;
  graph: FlowGraph;
};

export const BLUEPRINTS: BlueprintTemplate[] = [
  {
    id: "bom-transform",
    name: "BOM Transformation Pipeline",
    category: "ETL & Transform",
    description:
      "Fetches hierarchical BOM structure from ThingWorx, filters active parts, and transforms the schema for downstream ERP ingestion.",
    graph: {
      nodes: [
        {
          id: "node_1",
          x: 80,
          y: 120,
          label: "FetchParts",
          kind: "service",
          collection: "Things",
          entityName: "PTC.ProductionServer",
          serviceName: "GetPartsList",
          params: [],
          resultType: { name: "result", description: "", baseType: "INFOTABLE", aspects: {} },
          inputs: {},
        },
        {
          id: "node_2",
          x: 360,
          y: 120,
          label: "FilterActive",
          kind: "filter",
          mode: "expression",
          condition: "{{ $item.status === 'Active' }}",
          conditions: [],
          combinator: "and",
          convertTypes: true,
          inputs: {},
        },
        {
          id: "node_3",
          x: 640,
          y: 120,
          label: "FormatERP",
          kind: "code",
          code: "// Format each row for ERP consumption\nreturn $json.rows.map(r => ({\n  partNumber: r.partNumber,\n  qty: r.quantity || 1,\n  syncedAt: new Date().toISOString()\n}));",
          inputs: {},
        },
      ],
      edges: [
        { id: "e1", source: "node_1", target: "node_2" },
        { id: "e2", source: "node_2", target: "node_3" },
      ],
    },
  },
  {
    id: "dataset-diff",
    name: "Two-Way Dataset Difference (Reconciler)",
    category: "Reconciliation",
    description:
      "Queries source and target ThingWorx data tables, executes a key-based record comparison, and branches into differing rows.",
    graph: {
      nodes: [
        {
          id: "node_a",
          x: 80,
          y: 80,
          label: "GetSourceData",
          kind: "service",
          collection: "Things",
          entityName: "PTC.SourceSystem",
          serviceName: "GetTableData",
          params: [],
          resultType: { name: "result", description: "", baseType: "INFOTABLE", aspects: {} },
          inputs: {},
        },
        {
          id: "node_b",
          x: 80,
          y: 240,
          label: "GetTargetData",
          kind: "service",
          collection: "Things",
          entityName: "PTC.TargetSystem",
          serviceName: "GetTableData",
          params: [],
          resultType: { name: "result", description: "", baseType: "INFOTABLE", aspects: {} },
          inputs: {},
        },
        {
          id: "node_cmp",
          x: 380,
          y: 140,
          label: "ReconcileKeys",
          kind: "compare",
          keyA: "id",
          keyB: "id",
          resolve: "b",
          inputs: {},
        },
      ],
      edges: [
        { id: "e_a", source: "node_a", target: "node_cmp" },
        { id: "e_b", source: "node_b", target: "node_cmp" },
      ],
    },
  },
  {
    id: "telemetry-alert",
    name: "Device Telemetry Polling & Alerting",
    category: "IoT & Telemetry",
    description:
      "Polls real-time machine temperature and vibration telemetry, tests warning threshold conditions, and stops on anomalies.",
    graph: {
      nodes: [
        {
          id: "node_tel",
          x: 80,
          y: 120,
          label: "ReadTelemetry",
          kind: "service",
          collection: "Things",
          entityName: "PTC.FactoryFloor",
          serviceName: "GetMachineTelemetry",
          params: [],
          resultType: { name: "result", description: "", baseType: "INFOTABLE", aspects: {} },
          inputs: {},
        },
        {
          id: "node_if",
          x: 360,
          y: 120,
          label: "CheckThresholds",
          kind: "if",
          condition: "{{ $json.rows[0].temperature > 95 }}",
          inputs: {},
        },
        {
          id: "node_stop",
          x: 640,
          y: 120,
          label: "AlertAnomaly",
          kind: "stop",
          message: "Critical Overheating Alarm: Temperature exceeds 95C",
          inputs: {},
        },
      ],
      edges: [
        { id: "e_tel", source: "node_tel", target: "node_if" },
        { id: "e_if", source: "node_if", target: "node_stop", sourcePort: "true" },
      ],
    },
  },
  {
    id: "bulk-batch-loop",
    name: "Batch Item Splitter & Sequential Processor",
    category: "Integration",
    description:
      "Batches large InfoTables into chunks of 10 items to iterate through sequentially with rate limiting.",
    graph: {
      nodes: [
        {
          id: "node_items",
          x: 80,
          y: 120,
          label: "GetAllItems",
          kind: "service",
          collection: "Things",
          entityName: "PTC.InventoryManager",
          serviceName: "QueryItems",
          params: [],
          resultType: { name: "result", description: "", baseType: "INFOTABLE", aspects: {} },
          inputs: {},
        },
        {
          id: "node_loop",
          x: 360,
          y: 120,
          label: "SplitInBatches",
          kind: "loop",
          batchSize: 10,
          inputs: {},
        },
        {
          id: "node_wait",
          x: 640,
          y: 120,
          label: "ThrottleInterval",
          kind: "wait",
          mode: "interval",
          waitMs: 500,
          until: "",
          inputs: {},
        },
      ],
      edges: [
        { id: "e_in", source: "node_items", target: "node_loop" },
        { id: "e_loop", source: "node_loop", target: "node_wait", sourcePort: "loop" },
      ],
    },
  },
];
