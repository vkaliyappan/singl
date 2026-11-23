# scripts

Developer and ops tools for singl, written in Rust. They are one crate,
`singl-scripts`, that belongs to the Cargo workspace in `src-tauri/`, so they
share its `Cargo.lock` and build into `src-tauri/target/`.

| Tool | What it does | Replaces |
|---|---|---|
| `singl-release` | Bumps the version, builds the NSIS installer, publishes it to the update folder | `release.mjs` |
| `twx-auth` | Checks or refreshes the saved ThingWorx login used by UI tests | singl-web `twx-auth.ts` |
| `singl-web` | Starts, stops, restarts or redeploys the singl-web production server | singl-web `redeploy.bat`, `restart.bat`, `start-dev.bat`, `start-dev.vbs` |
| `reinstall-from-zip` | Reinstalls FSCapture112 and removes its registry key, or reinstalls another portable app from a ZIP | singl-web `reinstall-fscapture.bat` |

`build-flow-engine.mjs` is still JavaScript (it drives esbuild): run it with `pnpm flow:engine`.

The Teams Presence Keeper is no longer a script. It is built into the app
(`src-tauri/src/commands/presence.rs`) and is started from the app's UI.

## Requirements

- Rust (the version in `rust-version`, 1.90+) and pnpm.
- `twx-auth`: Node.js with `npx` and Microsoft Edge (it drives Playwright MCP, like the app).
- Run every command from the singl checkout (or any folder inside it).

## How to run

Use the pnpm commands; they build the tool if needed, then run it. Anything
after the command name is passed to the tool.

```powershell
pnpm release --bump bugfix --notes "What changed"
pnpm twx:auth:check --env CHB-QA
pnpm web:restart
```

Or run a tool directly through Cargo:

```powershell
cargo run -q --manifest-path src-tauri/Cargo.toml -p singl-scripts --bin <tool> -- <args>
```

To get standalone `.exe` files (for Task Scheduler, or to skip the build check):

```powershell
cargo build --release --manifest-path src-tauri/Cargo.toml -p singl-scripts
```

The executables are then in `src-tauri\target\release\` (`singl-release.exe`,
`twx-auth.exe`, `singl-web.exe`, `reinstall-from-zip.exe`).

Run the tests with:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -p singl-scripts
```

## singl-release

Builds the NSIS installer and publishes it to the folder that Settings → Updates
points at.

```powershell
pnpm release --bump bugfix --notes "Fixed the login check"
pnpm release --version 1.2.0 --notes "New UI tests page"
pnpm release --bump minor --debug
pnpm release --skip-build --dir "D:\singl-updates"
```

| Option | Meaning |
|---|---|
| `--bump major\|minor\|bugfix` | Raise the version in `src-tauri/tauri.conf.json` and `package.json` before building. `major` resets minor and bugfix; `minor` resets bugfix. `patch` = `bugfix`. |
| `--version x.y.z` | Set the version outright. It must be higher than the current one. |
| `--notes "<text>"` | Release notes written to `latest.json`. |
| `--debug` | Build with `tauri build --debug`. Use this when Smart App Control blocks a release build. |
| `--skip-build` | Publish the installer that is already built. |
| `--dir <folder>` | Where to publish. Falls back to `SINGL_UPDATE_DIR`, then `releases/` in the project. |

With neither `--bump` nor `--version`, the current version is built as is.
Installed apps only update to a higher version. The installer is copied first and
`latest.json` is written last, so clients never see a version whose file is missing.

## twx-auth

Manages the saved ThingWorx login for an environment. It is the same login the
app's App Tests page uses (`<app data>\uitest\sessions\`), so a refresh here is
seen by the app too.

```powershell
pnpm twx:auth:check --env CHB-QA
pnpm twx:auth:login --env CHB-QA
```

- `check`: opens the environment headless with the saved login and reports
  whether it still reaches the ThingWorx app.
- `login`: opens Edge at the environment. Finish SSO/MFA there; the login is saved
  automatically once the browser is back in ThingWorx (waits up to 5 minutes).

| Option | Meaning |
|---|---|
| `--env <id>` | Environment name as shown in singl. Optional when only one environment has a ThingWorx URL. Falls back to `SINGL_TWX_ENV`. |
| `--db <path>` | singl database. Falls back to `SINGL_DB`, then `%APPDATA%\com.singl.app\singl.db`. |

| Exit code | Meaning |
|---|---|
| 0 | Valid / saved |
| 1 | No saved login (`check`) |
| 2 | Login expired, or an error during `check` |
| 3 | Login failed or timed out |
| 64 | Bad arguments |

The browser uses the environment's own Edge profile: close the app's login
window or UI test run for that environment first. Cookie values are never printed.

## singl-web

Runs the singl-web production server (Next.js, `pnpm start`).

```powershell
pnpm web:start
pnpm web:restart
pnpm web:redeploy
pnpm web:stop
```

| Command | What it does |
|---|---|
| `start` | Starts the built server hidden and detached, then waits until it listens. Add `--foreground` to run it in this terminal instead. |
| `restart` | Stops whatever listens on the port, starts the server again and waits up to 30 s for it to listen. No build. |
| `redeploy` | Stops the server, runs `pnpm build`, and starts it again only if the build passed. Use after pulling or editing code. |
| `stop` | Kills whatever listens on the port (and its child processes). |

| Option | Meaning |
|---|---|
| `--dir <folder>` | The singl-web checkout. Falls back to `SINGL_WEB_DIR`, then `C:\MyFiles\Develop\singl-web`. |
| `--port <n>` | Port the server listens on. Default `3001`. |

`stop`, `restart` and `redeploy` kill *any* process listening on the port, not
only singl-web, as the old `.bat` files did.

**Start at sign-in (Task Scheduler):** build the release executables (see above),
then create a task with an "At log on" trigger whose action is:

```
Program:   C:\MyFiles\Develop\singl\src-tauri\target\release\singl-web.exe
Arguments: start
```

## reinstall-from-zip

On Windows, run without arguments to reinstall FSCapture112. The tool deletes
`C:\MyFiles\Soft\FSCapture112`, checks for and extracts
`C:\MyFiles\Soft\FSCapture112.zip` into `C:\MyFiles\Soft` using Windows
PowerShell, then removes `HKCU\Software\8322898` if present. A missing ZIP
stops the reinstall after folder deletion.

```powershell
cargo run -q --manifest-path src-tauri/Cargo.toml -p singl-scripts --bin reinstall-from-zip
```

For another portable app, pass its paths explicitly. This mode checks that the
ZIP exists before deleting the folder and skips the registry step.

```powershell
cargo run -q --manifest-path src-tauri/Cargo.toml -p singl-scripts --bin reinstall-from-zip -- --target "C:\MyFiles\Soft\MyApp" --zip "C:\MyFiles\Soft\MyApp.zip"
```

| Option | Meaning |
|---|---|
| `--target <folder>` | Folder to delete and recreate. |
| `--zip <file>` | Zip to extract. |
| `--dest <folder>` | Where to extract. Default: the target's parent folder, for zips whose top-level folder is the target. |
