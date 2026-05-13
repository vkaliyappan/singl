import fs from "fs";
import path from "path";
import crypto from "crypto";

export type NodeStatus = "added" | "removed" | "modified" | "identical";

export interface DiffNode {
  path: string;
  name: string;
  type: "file" | "dir";
  status: NodeStatus;
  leftExists: boolean;
  rightExists: boolean;
  leftSize?: number;
  rightSize?: number;
  children?: string[];
}

const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".turbo"]);

const TEXT_EXTENSIONS = new Set([
  "js","ts","jsx","tsx","mjs","cjs","json","jsonc",
  "xml","html","htm","css","scss","sass","less",
  "md","mdx","txt","log","sh","bash","ps1","bat",
  "yaml","yml","toml","ini","env","sql","graphql","gql",
  "py","rb","go","rs","java","kt","cs","php","swift","scala","c","cpp","h","hpp",
  "vue","svelte","prisma","dockerfile",
]);

function isTextFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name === ".gitignore" || name === ".editorconfig") return true;
  return TEXT_EXTENSIONS.has(ext);
}

/** Hash file content; for text files normalizes CRLF→LF so Windows checkouts match Unix exports. */
function sha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  if (isTextFile(filePath)) {
    const normalized = data.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Returns a flat map of relPath → absolute path for all files/dirs under root. */
function walkDir(root: string): Map<string, string> {
  const result = new Map<string, string>();

  function recurse(dir: string, rel: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      result.set(relPath, absPath);
      if (entry.isDirectory()) {
        recurse(absPath, relPath);
      }
    }
  }

  if (!fs.existsSync(root)) return result;
  recurse(root, "");
  return result;
}

export interface MergeResult {
  nodes: DiffNode[];
  summary: { added: number; removed: number; modified: number; identical: number };
}

export function mergeTrees(leftRoot: string, rightRoot: string): MergeResult {
  const [leftMap, rightMap] = [walkDir(leftRoot), walkDir(rightRoot)];
  const allPaths = new Set([...leftMap.keys(), ...rightMap.keys()]);

  const nodeMap = new Map<string, DiffNode>();
  const summary = { added: 0, removed: 0, modified: 0, identical: 0 };

  for (const relPath of allPaths) {
    const leftAbs = leftMap.get(relPath);
    const rightAbs = rightMap.get(relPath);

    const leftIsDir = leftAbs ? fs.statSync(leftAbs).isDirectory() : false;
    const rightIsDir = rightAbs ? fs.statSync(rightAbs).isDirectory() : false;
    const isDir = leftIsDir || rightIsDir;

    const name = relPath.split("/").pop() ?? relPath;

    if (isDir) {
      nodeMap.set(relPath, {
        path: relPath,
        name,
        type: "dir",
        status: "identical",
        leftExists: !!leftAbs,
        rightExists: !!rightAbs,
        children: [],
      });
      continue;
    }

    // Both exist — compare (skip size shortcut: CRLF normalisation changes byte counts)
    if (leftAbs && rightAbs) {
      const leftSize = fs.statSync(leftAbs).size;
      const rightSize = fs.statSync(rightAbs).size;
      let status: NodeStatus;
      if (sha256(leftAbs) === sha256(rightAbs)) {
        status = "identical";
        summary.identical++;
      } else {
        status = "modified";
        summary.modified++;
      }
      nodeMap.set(relPath, {
        path: relPath, name, type: "file", status,
        leftExists: true, rightExists: true, leftSize, rightSize,
      });
    } else if (leftAbs) {
      summary.removed++;
      nodeMap.set(relPath, {
        path: relPath, name, type: "file", status: "removed",
        leftExists: true, rightExists: false,
        leftSize: fs.statSync(leftAbs).size,
      });
    } else if (rightAbs) {
      summary.added++;
      nodeMap.set(relPath, {
        path: relPath, name, type: "file", status: "added",
        leftExists: false, rightExists: true,
        rightSize: fs.statSync(rightAbs!).size,
      });
    }
  }

  // Build children lists and roll up dir statuses
  for (const relPath of nodeMap.keys()) {
    const parentPath = relPath.includes("/")
      ? relPath.slice(0, relPath.lastIndexOf("/"))
      : null;
    if (parentPath) {
      const parent = nodeMap.get(parentPath);
      if (parent?.type === "dir") {
        parent.children ??= [];
        parent.children.push(relPath);
      }
    }
  }

  // Roll up: a dir is "modified" if any descendant file is non-identical
  function rollupDir(node: DiffNode): NodeStatus {
    if (node.type === "file") return node.status;
    let anyNonIdentical = false;
    for (const childPath of node.children ?? []) {
      const child = nodeMap.get(childPath);
      if (!child) continue;
      if (rollupDir(child) !== "identical") anyNonIdentical = true;
    }
    node.status = anyNonIdentical ? "modified" : "identical";
    return node.status;
  }

  // Only roll up root-level dirs
  for (const [relPath, node] of nodeMap) {
    if (!relPath.includes("/") && node.type === "dir") {
      rollupDir(node);
    }
  }

  // Sort children: dirs first, then alpha
  for (const node of nodeMap.values()) {
    if (node.children) {
      node.children.sort((a, b) => {
        const an = nodeMap.get(a)!;
        const bn = nodeMap.get(b)!;
        if (an.type !== bn.type) return an.type === "dir" ? -1 : 1;
        return an.name.localeCompare(bn.name);
      });
    }
  }

  return { nodes: [...nodeMap.values()], summary };
}
