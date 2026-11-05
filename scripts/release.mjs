// Builds the NSIS installer and publishes it to the update folder that
// Settings → Updates points at (see src-tauri/src/commands/updater.rs).
//
//   pnpm release --notes "What changed" [--debug] [--dir "<folder>"]
//
// --dir falls back to SINGL_UPDATE_DIR, then releases/ in the project. Bump "version" in
// src-tauri/tauri.conf.json first: installed apps only update to a higher one.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    notes: { type: "string", default: "" },
    "skip-build": { type: "boolean", default: false },
    // Smart App Control blocks the fresh build scripts a release build needs;
    // a debug build reuses the ones `tauri dev` already ran.
    debug: { type: "boolean", default: false },
  },
})

// Defaults to releases/ in the project; point Settings → Updates at the same folder.
const dir = resolve(values.dir ?? process.env.SINGL_UPDATE_DIR ?? "releases")
mkdirSync(dir, { recursive: true })

const { productName, version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))

if (!values["skip-build"]) {
  const args = ["tauri", "build", "--bundles", "nsis", ...(values.debug ? ["--debug"] : [])]
  const build = spawnSync("pnpm", args, { stdio: "inherit", shell: true })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const installer = `${productName}_${version}_x64-setup.exe`
const built = join("src-tauri", "target", values.debug ? "debug" : "release", "bundle", "nsis", installer)
if (!existsSync(built)) {
  console.error(`Installer not found: ${built}`)
  process.exit(1)
}

// Installer first, manifest last, so a client never sees a version whose file is missing.
copyFileSync(built, join(dir, installer))
const manifest = { version, installer, notes: values.notes, publishedAt: new Date().toISOString() }
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n")

console.log(`Published ${productName} ${version} to ${dir}`)
