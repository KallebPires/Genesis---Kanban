# AGENTS.md — Genesis Kanban

Instructions for AI coding agents (Claude, etc.) working in this repo. Read this before making changes.

## What this is

Genesis is a small internal ops tool: kanban board, projects, team, and a lightweight finance view. Single team-sized app, not a multi-tenant SaaS — don't add abstractions for scale this app doesn't need.

Stack: **vanilla JS frontend, no framework, no build step** + a **Node.js/Express + MongoDB** backend the frontend talks to over a small REST API. There is no other backend. Firebase was used earlier in this project's history and was fully ripped out — never reintroduce it or any other third-party cloud service without being asked.

## Layout

```
index.html, app.js, styles.css, assets/   — the whole frontend (static files, no build step)
server/                                   — Express + MongoDB API + the static file server for the frontend above
mcp/                                      — local MCP server (stdio) so Claude can drive the API; holds no data itself
```

Files that exist but are **not part of the running app** — leftover source from the original design tool, safe to ignore or delete: `Genesis.dc.html`, `_ds/`, `support.js`, `.thumbnail`, `uploads/`.

## Frontend (`app.js`)

Everything is one file, hand-rolled, no React/Vue/build step. The pattern:

- `state` is a single mutable object. `setState(patch)` merges into it and calls `render()`, which does a **full `innerHTML` rebuild** of `#app` from `computeView()` + template functions (`tDash`, `tBoard`, `tTeam`, etc.) — there is no virtual DOM, no diffing.
- Event handlers aren't inline JS in the HTML string — they're registered via `on(fn)`, which stores the closure in a `Map` keyed by a fresh id and returns `data-click="<id>"` (same pattern for `data-input`/`data-change`/`data-keydown`/`data-dragstart`/`data-dragover`/`data-drop`). One delegated listener per event type on `document` (set up once in `bindOnce()`) looks the id up and calls it. The handler map is cleared and rebuilt on every render.
- Hover styles use `data-hover="<css>"` + a delegated `mouseover`/`mouseout` pair that swaps the element's inline `style` attribute — not CSS classes. Follow this pattern for new hover states rather than adding `:hover` rules to `styles.css`.
- Any dynamic value that ends up in the HTML string **must** go through `esc()` (text content) or `escAttr()` (attribute values) — there's no framework auto-escaping here, and task titles/descriptions/comments are user-supplied text rendered via raw `innerHTML`.
- Because the whole page is torn down and rebuilt on every keystroke, two things bit us in production and are now handled — don't undo them:
  - **Focus/cursor restoration** (`withFocusPreserved`): inputs of `type="email"`/`number`/etc. don't support `selectionStart`/`setSelectionRange` at all (they throw or read `null`). The fix re-assigns `el.value = el.value` to force the caret to the end for those types, and uses real selection restore for types that support it. If you add a new input type, check whether it supports selection before assuming the generic path works — a naive assumption here once caused typed text to render **reversed** (each keystroke landing at position 0 instead of the end).
  - **No CSS `animation`/`transition` on elements that re-render on every keystroke** (e.g. a modal open while its own form fields are being typed into) — since the node is recreated each render, a CSS entrance animation restarts every time, which reads as the whole modal flickering. Modals in this app intentionally have no entrance animation for this reason.
- API calls go through the `api(path, options)` helper (adds the JWT from `localStorage`, throws with `.apiMessage` set from the server's `{error}` body on non-2xx). Don't call `fetch` directly elsewhere in `app.js`.
- After login, a `setInterval` (`loadAllData` every 8s) re-fetches users/projects/tasks to approximate cross-client live sync — there's no websocket/SSE. If you need faster propagation, this interval is the place to tune, not a place to bolt on a new sync mechanism unless asked.

## Backend (`server/`)

- CommonJS, Express, official `mongodb` driver (no Mongoose/ODM — documents are plain objects, `_id` is the Mongo `ObjectId`; API responses convert it to a string `id` via `toPublicDoc`/`toPublicUser`).
- Auth is JWT (`jsonwebtoken`) signed with `JWT_SECRET`, password hashes via `bcryptjs`. There is **no self-signup** — accounts are created only by an existing admin (`POST /api/users`, `requireAdminOrApiKey`) or by `server/seed-admin.js` (one-time bootstrap, run directly on the server).
- `server/auth.js` also defines a **static API key** path (`x-api-key` header checked against `MCP_API_KEY` env var) used by the local MCP server and a ChatGPT Custom GPT Action to act with admin-equivalent access without a per-user login. Its actions are attributed to a synthetic `"Integração (MCP/GPT)"` user so they're visible as agent-driven in the activity feed — don't collapse that distinction.
- **Security model — read before touching `server/auth.js` or the `users` collection:** only an existing admin (or the API key) may create/update a user document with `isAdmin: true`; a non-admin can only touch their own document and cannot grant themselves admin. This is enforced in `server/index.js`'s `POST /api/users`/`DELETE /api/users/:id` handlers via `requireAdmin`/`requireAdminOrApiKey` — there is deliberately no route that lets a logged-in user PATCH their own `isAdmin` field. If you add any way to edit a user document, keep that guarantee: re-check `req.user.isAdmin` server-side before ever writing `isAdmin` for anyone (including "self-service profile" style features) — an equivalent gap was caught and closed once already during development.
- `server/github.js` + `server/githubSync.js` implement bidirectional GitHub Issues ↔ task sync. Nothing about a specific repo or account is hardcoded — `owner`/`repo` are always passed in per call (`POST /api/github/repos`). Sync direction: GitHub issue open/closed maps to task `col` (`done` ⇄ anything else); comments propagate both ways; a task only pushes to GitHub if it has `githubRepoId`/`githubIssueNumber` set. If you touch this, know that **GitHub's `since`-filtered issues-list endpoint has a few seconds of eventual-consistency lag** after a very recent write — don't "fix" an apparent missed sync by adding retry loops; at the real 5-minute poll interval this is a non-issue, it only shows up when testing with sub-5-second round trips.
- Static frontend files are served via **explicit route allowlist** (`GET /`, `/app.js`, `/styles.css`, `/assets/*`), not a blanket `express.static` over the repo root — that's deliberate, to avoid ever serving `.git/`, `server/`, or the leftover design-source files. Keep new static assets on this explicit list rather than widening it to a directory-wide static mount.

## `mcp/`

A separate small ESM package, meant to run **locally** on whichever machine has Claude Desktop/Code (not on the VPS). It's a thin wrapper: every tool call is a `fetch` to the real server's REST API using `GENESIS_API_URL` + `GENESIS_API_KEY` env vars. It holds no state and talks to no database directly — if you add a tool, make it call the existing REST API rather than reaching into Mongo.

`server/openapi.yaml` describes the same REST endpoints for a ChatGPT Custom GPT Action. If you add/change an API endpoint that should be usable from chat, update **both** `mcp/index.js` (add a `server.tool(...)`) and `openapi.yaml` (add the path) — they're two views of the same surface and tend to drift if only one is touched.

## Running locally

There's no static-only mode anymore — the app requires the Node server (and a MongoDB it can reach) to do anything, including just showing the login screen meaningfully. `cd server && npm install`, copy `.env.example` to `.env`, point `MONGODB_URI` at a real or local Mongo, `node seed-admin.js "Name" email pass` once, then `node index.js`. For a one-off local check without a real Mongo install, `mongodb-memory-server` (installed ad hoc, not a real dependency) works for spinning up a throwaway instance — see git history / prior sessions for the pattern if needed, don't add it to `package.json`.

## Testing approach used so far

No test framework is set up. Verification in this project has been: boot the server against a real (or in-memory) MongoDB, then drive the actual UI with Playwright (`chromium.launch` + real clicks/fills/screenshots) rather than unit-testing template functions in isolation — the bugs that mattered here (flicker, reversed text, drag-and-drop breaking) only showed up when the real DOM/browser was exercised. If you're asked to verify a change, prefer that same style of end-to-end check over guessing from reading the code.

## Current status (keep this section updated)

Code is feature-complete for: kanban/projects/team/finance UI, Node+Mongo backend, admin-gated invites, GitHub Issues bidirectional sync, MCP server, ChatGPT Action schema. **Not yet deployed** — nobody has run this on the actual VPS yet (Claude has no access to it). Don't assume production is live; ask before claiming something works "in prod."
