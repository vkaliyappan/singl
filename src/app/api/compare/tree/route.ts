import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { appSettings, repoSettings } from "@/db/schema";
import { mergeTrees } from "@/lib/compare/diff-tree";

export async function GET(request: NextRequest) {
  const env = request.nextUrl.searchParams.get("env");
  if (!env) {
    return NextResponse.json({ error: "env is required" }, { status: 400 });
  }

  try {
    const [appRows, repoRows] = await Promise.all([
      db.select().from(appSettings).limit(1),
      db.select().from(repoSettings).limit(1),
    ]);

    const app = appRows[0];
    const repo = repoRows[0];

    if (!repo?.repoSlug) {
      return NextResponse.json({ error: "No repository configured. Clone a repo first." }, { status: 400 });
    }

    const twxRootPrefix = app?.twxRootPrefix ?? "WindchillClients/Thingworx";
    const repoRootSubpath = app?.repoRootSubpath ?? "";

    const cwd = process.cwd();
    const leftRoot = path.resolve(/*turbopackIgnore: true*/ cwd, "repos", repo.repoSlug, repoRootSubpath);
    const rightRoot = path.resolve(/*turbopackIgnore: true*/ cwd, "twx-entities", env, twxRootPrefix);

    const reposBase = path.resolve(cwd, "repos");
    const twxBase = path.resolve(cwd, "twx-entities");

    if (!leftRoot.startsWith(reposBase)) {
      return NextResponse.json({ error: "Invalid repo subpath" }, { status: 400 });
    }
    if (!rightRoot.startsWith(twxBase)) {
      return NextResponse.json({ error: "Invalid TWX root prefix" }, { status: 400 });
    }

    const { nodes, summary } = mergeTrees(leftRoot, rightRoot);
    return NextResponse.json({
      leftRoot: path.relative(cwd, leftRoot),
      rightRoot: path.relative(cwd, rightRoot),
      nodes,
      summary,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build diff tree" },
      { status: 500 }
    );
  }
}
