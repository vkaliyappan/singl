---
name: thingworx-testing
description: Test any ThingWorx web application reachable from the PTC Navigate landing page (e.g. CHBU Landing Page, Options Inheritance App, Option Costing Report) in a real browser with Playwright, reusing the stored SSO session in playwright/.auth/twx-auth.json. Use when the user asks to write, run, debug or fix an e2e/UI test against ThingWorx, check a mashup in the browser, reproduce a UI bug on the TWX test server, or refresh the TWX login. For REST-level inspection (entities, properties, services) use the thingworx-mcp skill instead.
---

# Testing the ThingWorx app with Playwright

Tests run against a **live ThingWorx server**, not the local Next.js app. Nothing is mocked; every action hits real data.

> **Location:** the Playwright suite, config, `scripts/twx-auth.ts`, `playwright/.auth/` and `test-results/` live in **`C:\MyFiles\Develop\singl-web`**, not in singl. Every path below is relative to that folder, and every `pnpm` command runs from there.

## Target

| What | Value |
|------|-------|
| Server | `https://championhomes-nav-test.cloud.thingworx.com` |
| **Main entry (start here)** | `https://championhomes-nav-test.cloud.thingworx.com/Thingworx/Runtime/index.html?mashup=Mashup.CHBPR.LandingPageNavigate#master=PTC.Nav.LandingPage.Master&mashup=LandingPageAccessAppMashup&__applyThemeName=PTC%20Convergence%20Theme` |
| Main entry loaded check | URL contains `Mashup.CHBPR.LandingPageNavigate` |
| CHBU app (direct link) | `https://championhomes-nav-test.cloud.thingworx.com/Thingworx/Runtime/index.html?mashup=Mashup.CHBU.LandingPage&continue` |
| Existing suite | `tests/ThingworxTest/inheritanceApp.spec.ts` (CHBU only) |
| Config | `playwright.config.ts` (`testDir: ./tests`, projects chromium/firefox/webkit) |

The main entry is the **PTC Navigate landing page** (master mashup `PTC.Nav.LandingPage.Master`). **Every application** on the server can be opened from there, not just CHBU/Inheritance. To test an app:
- start at the main entry and click through to the app, which is how a real user arrives; or
- if the app has its own mashup, deep-link with `index.html?mashup=<MashupName>&continue`, which is faster and skips the tile navigation.

To learn which apps exist, open the main entry and take a `browser_snapshot` (see below). To find a mashup's name, use the `thingworx-mcp` skill, e.g. `twx_list_entities` with type `Mashups`. Don't guess app names.

All apps share one domain, so one stored session covers all of them.

The config's `baseURL` (`localhost:3000`) does **not** apply. ThingWorx specs use the full URL.

## Auth: stored session

Login is SSO: ThingWorx → PingFederate (`championhomes-test-pingfed-runtime.cloud.thingworx.com`) → Microsoft Entra (`login.microsoftonline.com`), with MFA. An agent **cannot log in on its own**, because a human has to finish the login once.

The session is stored in **`playwright/.auth/twx-auth.json`** (Playwright `storageState` format: cookies + origins).
- `JSESSIONID` (TWX): a session cookie that expires server-side after it has been idle.
- `PF.PERSISTENT`, `ESTSAUTHPERSISTENT`: long-lived SSO cookies. Even after `JSESSIONID` dies, these usually re-authenticate silently through the redirect chain, so the landing page loads with no prompt.
- The file is gitignored (`/playwright/.auth/`). **Never commit it, print its cookie values, paste it into chat, or send it anywhere.** It is a live credential.

### Use it in a spec

```ts
import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const authFile = path.join(__dirname, '../../playwright/.auth/twx-auth.json');

test.use({
  storageState: fs.existsSync(authFile) ? authFile : undefined,
});
```

Adjust the relative path to where the spec lives, measured from the repo root. After the landing page loads, save the refreshed state so the next run starts warm:

```ts
await page.context().storageState({ path: authFile });
```

`navigateToLandingPage(page)` in `inheritanceApp.spec.ts` already does all of this for the CHBU app: go to the URL, detect a login page, wait up to 4 min for manual login, save the state. It is hard-wired to `Mashup.CHBU.LandingPage`. For a new app, make it generic rather than copying it: take `url` and `readyUrlPart` parameters, and default to the main entry and `PTC.Nav.LandingPage.Master`.

The main entry uses a hash (`#master=...`), so the ready check must use `url.href` (which includes the hash), not `url.pathname`/`search`.

### Required first step: make sure a valid session exists

**Before running or exploring any ThingWorx test, always do this:**

1. **Check:**
   ```bash
   pnpm --silent twx:auth:check
   ```
   This is headless. It loads `playwright/.auth/twx-auth.json`, opens the main entry, and waits up to 45 s to see whether it reaches the app. It never prints cookie values.

   | Output / exit | Meaning | Next |
   |---------------|---------|------|
   | `VALID` / 0 | Session works. Cookies refreshed and saved back to the file. | Run tests. |
   | `NO_AUTH` / 1 | No file stored yet. | Step 2. |
   | `EXPIRED` / 2 | File exists, but it ended on a PingFed/Entra login page. | Step 2. |

2. **Login (only if step 1 was not VALID).** Stop and **ask the user** before opening the browser, e.g. *"No valid ThingWorx session is stored. I'll open a browser window; please finish the SSO/MFA login there. OK?"* After the user confirms, run:
   ```bash
   pnpm --silent twx:auth:login
   ```
   This opens a **headed** Chromium at the main entry and waits up to 5 min for the user to reach the app. It then saves the session to `playwright/.auth/twx-auth.json`.
   - `SAVED` / 0: done.
   - `LOGIN_FAILED` / 3: the user didn't finish in time or closed the window. Tell them, and offer to retry. **Don't loop.**

3. **Re-check** with `pnpm --silent twx:auth:check`. It must print `VALID` before any test runs.

Every later test run reuses the stored file through `storageState` (see above). There is no need to log in again until the check reports `EXPIRED`.

Rules:
- Never try to complete the login yourself. Don't type credentials, click through MFA, or ask the user for a password or code. The user logs in in the browser window, and only there.
- Headless runs **cannot** log in. If a test run prints "Authentication required. Waiting for user input…", stop it, then run steps 1–3.
- Script: `scripts/twx-auth.ts` (both modes). Target file: `playwright/.auth/twx-auth.json`.

## Running tests

Use pnpm only (never npx).

```bash
# whole ThingWorx suite, chromium, serial (recommended default)
pnpm test:e2e tests/ThingworxTest --project=chromium --workers=1

# one test by title
pnpm test:e2e tests/ThingworxTest -g "Use cache\" checked" --project=chromium --workers=1

# watch it / debug it
pnpm test:e2e tests/ThingworxTest --project=chromium --headed --workers=1
pnpm test:e2e:ui

# after a run
pnpm test:report          # HTML report; screenshots always, video+trace on failure
```

Always pass `--project=chromium --workers=1` unless the user asks otherwise. With `fullyParallel: true` and 3 browser projects, a bare `pnpm test:e2e` starts about 30 concurrent sessions against a shared test server.

Failure artifacts (latest run only) are in `test-results/.artifacts/<test>/`: `test-failed-*.png`, `video.webm`, `trace.zip`. Open a trace with `pnpm exec playwright show-trace test-results/.artifacts/<dir>/trace.zip`. Step screenshots are in `test-results/<test>_<browser>_<timestamp>/`. Look at the screenshot before guessing at a cause.

Timeouts to respect:
- default per test: 300 s (set in `beforeEach`)
- Option Costing Report, cached search: about 30–60 s
- Option Costing Report, uncached search: 5–10 min (the test allows 17)

Run long tests in the background and wait for the completion notification. Don't poll them.

## Screenshots

**Every test run gets its own directory: `test-results/<test-name>_<browser>_<YYYY-MM-DD_HH-mm-ss>/`.** Screenshots from earlier runs are kept. Never save screenshots in the repo root, `tests/`, `.playwright-mcp/`, or the scratchpad.

### Layout

```
test-results/
├── opens-Option-Costing-Report-via-hamburger-menu_chromium_2026-09-23_14-30-05/
│   ├── 01-landing.png
│   └── 02-option-costing-report.png
├── opens-Option-Costing-Report-via-hamburger-menu_chromium_2026-09-23_16-02-41/   # later run, kept
│   └── ...
├── mcp-option-costing-report_2026-09-23_15-10-00/     # manual Playwright MCP exploration
│   └── 01-main-entry.png
└── .artifacts/                                        # Playwright auto output, WIPED every run
    └── <spec>-<test>-chromium/  test-finished-1.png, test-failed-1.png, video.webm, trace.zip
```

- The directory name is built from the test title (slugged), the browser project, `_retryN` on retries, and the time the test started.
- `playwright.config.ts` sets `outputDir: 'test-results/.artifacts'`. Playwright deletes its `outputDir` at the start of every run, which is why its automatic screenshots, videos and traces live in that subdirectory, and why the timestamped directories survive. Failure traces and videos are therefore only available from the **latest** run, under `.artifacts/`.

### In specs: use `snap()`

Helper: `tests/ThingworxTest/twx-screenshots.ts`.

```ts
import { snap } from './twx-screenshots';

test('opens Option Costing Report via hamburger menu', async ({ page }) => {
  await navigateToLandingPage(page);
  await snap(page, 'landing');                  // -> 01-landing.png

  await navigateToOptionCostingReport(page);
  await snap(page, 'option costing report');    // -> 02-option-costing-report.png
});
```

- `snap(page, step)` numbers files automatically (`NN-<step>.png`), takes a full-page shot by default (`{ fullPage: false }` for the viewport only), and attaches the image to the HTML report.
- It works inside helpers too, because it uses `test.info()`, so there's no need to pass `testInfo` around.
- `screenshotDir()` returns the current test's directory, for saving anything else there (e.g. downloaded exports).
- Take one screenshot per meaningful step (navigation, a filter applied, grid loaded), not one per click.
- Don't call `page.screenshot({ path: ... })` with a hand-built path. Use `snap()` so the layout stays consistent.

### In Playwright MCP exploration

Use the same pattern, with `mcp-<app>` as the test name and one directory per session: `test-results/mcp-<app>_<YYYY-MM-DD_HH-mm-ss>/NN-<step>.png`.

```
mcp__playwright__browser_take_screenshot  filename: "test-results/mcp-option-costing-report_2026-09-23_15-10-00/01-main-entry.png"
```

If the MCP tool refuses paths outside `.playwright-mcp/`, save there and move the file into the directory above.

### Caveats

- Timestamped directories pile up. When the user asks to clean up, delete old `test-results/<test>_<timestamp>/` directories. Never delete them unprompted.
- `test-results/` is gitignored. Don't commit screenshots.
- Screenshots show live business data. Don't upload or share them outside the machine unless the user asks.
- After a run, tell the user the screenshot directory path. Look at the images with the Read tool before describing what they show.

## Exploring the UI before writing a test (Playwright MCP)

Use the `mcp__playwright__*` tools to find selectors interactively. First run the session check above; it must be `VALID`. The MCP browser does not share the Playwright test runner's storage, so load the stored cookies first:

```js
// mcp__playwright__browser_run_code_unsafe
async (page) => {
  const s = JSON.parse(require('fs').readFileSync('playwright/.auth/twx-auth.json', 'utf8'));
  await page.context().addCookies(s.cookies);
  await page.goto('https://championhomes-nav-test.cloud.thingworx.com/Thingworx/Runtime/index.html#master=PTC.Nav.LandingPage.Master');
}
```

If `require` is unavailable in that sandbox, read the file with the Read tool and pass the cookie array in literally. Don't echo the values back to the user. Then use `browser_snapshot` to read the accessibility tree and pick selectors. Save any screenshots per the **Screenshots** section (`test-results/mcp-<app>_<timestamp>/`). If you still land on a login page, the session is stale; ask the user to log in in that window.

## Writing tests: ThingWorx UI rules

ThingWorx mashups are built from `ptcs-*` web components (shadow DOM). Playwright CSS and text locators pierce open shadow roots, so plain locators usually work.

- **Reuse the helpers in `inheritanceApp.spec.ts`:** `navigateToLandingPage`, `selectProductContainer`, `expandTreeNode`, `navigateToOptionCostingReport`, `setUseCacheCheckbox`, `clickSearchButton`, `triggerSearchAndVerifyGrid`, `selectAllGridRows`, `getSelectedRowsCount`, `selectPlant`, `clickShowDistinctChoiceIdCombinations`. If a second spec needs them, move them into a shared `tests/ThingworxTest/twx-helpers.ts` rather than copying them.
- **Widgets:**
  - Dropdown: `ptcs-dropdown`. Options are `ptcs-list-item` / `[role="option"]` inside an overlay. Open the dropdown, click the option, then press `Escape`.
  - Checkbox: `ptcs-checkbox`. Read its state from the `.checked` property via `evaluate`, not from an attribute.
  - Button: `ptcs-button`. The real `<button>` is inside its shadowRoot. If `.click()` doesn't fire, also dispatch a `CustomEvent('action', { bubbles: true, composed: true })`.
  - Grid rows: `[role="row"]`, cells `getByRole('cell')`. Scope header checkboxes to the header row (e.g. `hasText: 'Spec Tree'`) to avoid matching the page's "Use cache" checkbox or the hidden `#draggable-checkbox`.
- **Never `waitForLoadState('networkidle')`:** ThingWorx polls constantly, so it never settles. Wait for concrete UI instead: `await expect(locator).toBeVisible({ timeout })`.
- **Prefer `expect(...).toBeVisible` over `waitForTimeout`.** Only use short fixed waits after a widget event with no visible signal.
- **Don't swallow failures in assertions.** `.catch(() => {})` is fine for optional fallbacks, but the step that proves the behavior must be an `expect` that can fail.
- Assert on real data patterns. Known ID shapes: choice `CH\d{6,}`, option `OP\d{6,}`, floorplan like `2448H32P02` / `16\d{2}H\d{2}P\d{2}`.
- Put each app's tests in its own spec under `tests/ThingworxTest/` (e.g. `<app>.spec.ts`), with shared login and navigation helpers in `twx-helpers.ts`.
- Known navigation (CHBU app): hamburger (top-left) → sidebar "Option Costing Report". The Landing page has a Product Container dropdown ("National Series") and a hierarchy tree (Prime → Multi Section → Benton → floorplans), with the "Standard Options and Choices" grid on the right.

## Safety

The test server holds real business data, and a UI click performs the real service call. Only automate read and search flows unless the user explicitly asks for a test that saves, edits or deletes. If they do, confirm first which record it will touch.
