// Builds the NSIS installer and publishes it to the update folder that
// Settings → Updates points at (see src-tauri/src/commands/updater.rs).
//
//   pnpm release --bump bugfix --notes "What changed" [--debug] [--dir "<folder>"]
//
// Versions are major.minor.bugfix. --bump major|minor|bugfix raises the version in
// src-tauri/tauri.conf.json (and package.json) before building: major resets minor and
// bugfix, minor resets bugfix. --version x.y.z sets it outright. With neither, the current
// version is built as is. Installed apps only update to a higher version.
// --dir falls back to SINGL_UPDATE_DIR, then releases/ in the project.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    bump: { type: "string" },
    version: { type: "string" },
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

const CONF = "src-tauri/tauri.conf.json"
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const conf = JSON.parse(readFileSync(CONF, "utf8"))
const { productName } = conf
let { version } = conf

if (values.bump || values.version) {
  if (values.bump && values.version) fail("Pass --bump or --version, not both.")
  const cur = SEMVER.exec(version)
  if (!cur) fail(`Current version "${version}" is not major.minor.bugfix.`)
  let [major, minor, bugfix] = cur.slice(1).map(Number)
  let next
  if (values.version) {
    if (!SEMVER.test(values.version)) fail(`--version must be major.minor.bugfix, got "${values.version}".`)
    next = values.version
  } else if (values.bump === "major") next = `${major + 1}.0.0`
  else if (values.bump === "minor") next = `${major}.${minor + 1}.0`
  else if (values.bump === "bugfix" || values.bump === "patch") next = `${major}.${minor}.${bugfix + 1}`
  else fail(`--bump must be major, minor or bugfix, got "${values.bump}".`)
  const n = next.split(".").map(Number)
  if (!(n[0] > major || (n[0] === major && (n[1] > minor || (n[1] === minor && n[2] > bugfix)))))
    fail(`${next} is not higher than ${version}; installed apps would not update.`)
  // Swap only the version strings so the files keep their formatting.
  setVersion(CONF, next)
  setVersion("package.json", next)
  console.log(`Version ${version} -> ${next}`)
  version = next
}

function setVersion(file, to) {
  const text = readFileSync(file, "utf8")
  // The first "version" field is the top-level one in both files.
  const re = /("version"\s*:\s*)"[^"]*"/
  if (!re.test(text)) fail(`No "version" field to update in ${file}.`)
  writeFileSync(file, text.replace(re, `$1"${to}"`))
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

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
