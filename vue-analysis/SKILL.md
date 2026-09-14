---
name: vue-analysis
description: Statically analyze Vue 3 Options API code in either shape it shows up in a legacy codebase - CDN/global (Vue loaded via <script src>, components registered with Vue.component()/Vue.createApp(), referenced straight in HTML markup, no bundler) or Vite/SFC (.vue files wired together with import/export). Follows the file graph (import/script-src/inline-script) and the template-render graph (which components a template actually uses) to reconstruct what one page renders, extracts every component's props/data/methods/computed/watch/emits/lifecycle hooks with doc comments, and produces the same four artifacts as php-analysis: facts.json, dependency-graph.md, functions-reference.md, SPEC.md. Use when asked to document, review, audit, or write a spec for Vue 3 Options API code, especially when CDN-style global components and Vite SFCs are mixed in the same project.
---

# vue-analysis

Sibling to `php-analysis` (`../php-analysis/SKILL.md` — same repo, same
output shape) for a codebase
where Vue 3 **Options API** code shows up in two different wirings that
don't look anything like each other on the page:

- **Vite/SFC/ESM** — `main.js` does `import App from './App.vue'`; `App.vue`
  imports child `.vue` files; the "which files make up this page" question
  is answered by the `import` graph, same spirit as PHP's `include` chain.
- **CDN/global** — a plain `.html` page loads Vue from a CDN URL, then one
  or more plain `.js` files via `<script src>` that call
  `Vue.component('name', {...})` to register a component **globally**,
  then the HTML markup itself (or another script's `template:` string)
  references that component **by tag name** with no `import` anywhere.
  This is the pattern most likely tangled up with legacy PHP output.

Both wirings use the same Options API shape underneath (`data`, `methods`,
`computed`, `watch`, `props`, `emits`, lifecycle hooks), so this skill's
driver (`scripts/extract.mjs`) parses a **real JS AST** (via the vendored
`acorn` npm package) and handles both: it follows `import`/`<script src>`/
inline-`<script>` edges to build the file graph, *and* separately resolves
which child component each template actually renders — via local
`components: {}` + import bindings for Vite, or via a page-wide registry of
`Vue.component()` names for CDN — so a component discovered only through
global registration and a raw HTML tag still shows up in the graph.

As with php-analysis: **read the extracted facts, then write the document
the user asked for.** The script only extracts and organizes facts; it does
not write prose, and skipping straight to eyeballing the source misses
exactly the things this tool exists to catch — a globally-registered CDN
component with no `import` anywhere, a method whose only caller is a
template `@click` binding, an emitted event that's declared but never
actually fired (or vice versa).

Paths below are relative to this skill's directory, `vue-analysis/`, unless
said otherwise. When used as a Claude Code skill, copy or symlink this whole
directory into a project's `.claude/skills/vue-analysis/`.

## Run (agent path)

```bash
node scripts/extract.mjs <entry> [<entry2> ...] --out <outdir> [--root <projectRoot>]
```

- Entries may be `.html`, `.js`/`.mjs`, or `.vue` files, **mixed freely in
  one run** — pass a Vite entry and a CDN HTML page together when they're
  part of the same project, same reasoning as passing multiple PHP entry
  points together.
- `--root` scopes relative-path display and, for an HTML entry, which files
  count as "loaded on this page" when building its global-component
  registry. Defaults to the common parent directory of the entry files.
- No `npm install` needed — `acorn` is vendored under
  `scripts/node_modules/`.

Verified end-to-end against the fixture in `example/` — a Vite app
(`main.js` → `App.vue` → `HelloWorld.vue` + a `<script setup>` Composition
API component mixed in, plus one deliberately-unregistered `<UnknownWidget>`
tag) and a CDN page (`legacy.html` loading Vue from a CDN URL, a
globally-registered `<counter>` widget from a separate `.js` file, and an
inline `<script>` mounting the root app), analyzed together in one run:

```bash
node scripts/extract.mjs example/vite-app/src/main.js example/cdn-app/legacy.html \
  --out example/output --root example
```

```
Analyzed 6 file(s), 4 component definition(s).
Unresolved edges: 1, external: 4
Output written to: .../example/output
```

`example/output/` is the real, committed output of that run — read it to
see the exact shape before using this on a real codebase.

### Output files (in `--out`)

| File | Contents |
|---|---|
| `facts.json` | Everything: per-file component definitions (props, data fields, methods/computed/watchers/lifecycle with doc comments, calls made, external state read, I/O, outputs), the file graph (import/script-src/inline-script/renders edges, resolved/external/unresolved). Ground truth — read before writing any narrative. |
| `dependency-graph.md` | Mermaid flowchart of the whole graph (imports, script tags, and template-render edges styled distinctly), an edge table, external packages/CDN URLs called out separately from genuine gaps, and an unresolved list. |
| `functions-reference.md` | One entry per component: props/data/emits/child-components, then each method/computed/watcher/lifecycle hook with its doc comment (or ⚠️ its absence, formal JSDoc vs. informal note distinguished) plus static facts. Coverage line at the end. |
| `SPEC.md` | Per entry point: files loaded, components rendered, props (inputs), external state actually read in code, emitted events (outputs), external I/O (HTTP/store/storage) **restricted to what the static call graph — including template event bindings — shows actually runs**, documented contracts verbatim from JSDoc, an explicit gaps list, a "defined but not called from this page" list, and unresolved items. |

### Writing the documentation the user actually asked for

Same division of labor as php-analysis: the script extracts facts, you
write the requested narrative grounded in them.

- **보안 관점:** walk `SPEC.md`'s External I/O section for unvalidated
  input → HTTP/store-mutation paths; every `⚠️ Unresolved` component tag or
  external CDN script is an unaudited surface — say so explicitly.
- **데이터 흐름:** trace Props → method calls (`calls` in `facts.json`) →
  emitted events / I/O, one component at a time, following `renders` edges
  outward from the entry.
- **업무 로직 설명:** lean on `Documented contracts` for anything with real
  JSDoc; mark everything in `Gaps` as inferred-from-code, not
  author-confirmed.
- **컴포넌트별 설명:** `functions-reference.md` is already that; add
  narrative framing if prose is wanted instead of a reference list.
- Never state something as "what this page does" if the tool flagged it
  dynamic/unresolved/external, or listed it under "defined but not called"
  — that's the whole point of running the extractor.

## Direct invocation (no full report — just the facts)

```bash
node scripts/extract.mjs example/vite-app/src/main.js --out /tmp/va --root example && grep -A3 '"declaredEmits"' /tmp/va/facts.json
```

## Gotchas

- **`<script setup>` (Composition API) is recognized but not deeply
  parsed.** This skill's scope is Options API. A `<script setup>` block is
  parsed just far enough to keep its `import`s in the file graph
  (`scriptSetupOnly: true` in facts.json) — no `ref()`/`reactive()`/`props`
  extraction is attempted. Verified with `CompositionWidget.vue` in the
  fixture: it shows up correctly in the dependency graph and doesn't crash
  the run, but contributes nothing to `functions-reference.md`. If a
  codebase is mostly Composition API, this tool will under-report it — say
  so rather than presenting a thin result as complete.
- **A method's only real caller can be a template binding, not other
  code.** `@click="refresh"` / `@greet="onGreet"` in a template are scanned
  and fed into the same call graph used for the "defined but not called"
  check — verified in the fixture: `App.onGreet` has no script-level caller
  at all (it only exists to handle `HelloWorld`'s `@greet` binding) and
  still correctly shows up as *called*, not as dead code.
- **A component discovered only via global registration + a raw HTML tag
  has no `import` anywhere to follow.** That's the entire point of the
  CDN-page registry pass (`computeHtmlPageRegistries`): it's scoped to
  "every file this specific HTML entry point loads" before matching tag
  names, so a `Vue.component()` registered by some *other*, unrelated page
  is correctly NOT resolved against a page that never loaded it.
- **The `calls` list only tracks two shapes on purpose:** a bare
  `someFunction()` or `this.someMethod()`. A recognized I/O/output pattern
  (`axios.get`, `this.$emit`, `this.$store.dispatch`, `console.log`, ...)
  is deliberately **not** also added to `calls` — it's already captured
  under `io`/`outputs` with a far more useful label, and adding it to
  `calls` too produced misleading bare-last-segment noise like `"Calls:
  get, dispatch"` during development. If you extend the tool with a new
  recognized call pattern, keep that split.
- **Props/`this.<x>` reads are only flagged as `prop:x` when `x` is in that
  *same* component's own declared `props`.** A template's `{{ x }}`
  interpolation is not scanned for reads beyond event-handler bindings and
  component tags — only script-level `this.x`/`props.x` access is tracked.
  A prop used only inside a template expression won't show up as "read" —
  say so rather than treating the reads list as exhaustive.
- **`--root`** determines which files count as "on this page" for the CDN
  global-component registry, not just display paths — get it right for
  multi-page CDN sites (see Run above).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `TypeError [ERR_INVALID_ARG_TYPE]: The "from" argument must be of type string` from `path.relative` inside `rel()` | Hit while developing this tool: when no `--root` is passed, a default must be computed (common parent dir of the entries) *before* it's used anywhere, including when a file has a parse error and contributes no edges. If you see this again after editing `extract.mjs`, check that `effectiveRoot` in `main()` is computed before `analyzeProject()` is called. |
| A component you know is used doesn't show a `renders` edge | Its tag name isn't in the file's local `components: {}` map (with a matching `import`) and isn't in the *owning HTML entry's* global registry (a `Vue.component()` call in a file that same entry point doesn't actually load). Check `htmlScripts`/`imports` in `facts.json` for that file. |
| `"Calls: get"` / `"Calls: dispatch"` in `functions-reference.md` | Already fixed in this driver (see the `calls`-list Gotcha above) — recognized I/O calls no longer get pushed into the generic call list. If it recurs after editing `extract.mjs`, check the `recognized` flag in `walkEntityBody`'s `CallExpression` branch. |
| A `.vue` file with a syntax error, or a `<script lang="ts">` block using TypeScript-only syntax | Reported as `parseError` on that file (acorn parses standard JS/ESM only, no TypeScript) rather than crashing the run — the rest of the file graph is still analyzed. Read `facts.json`'s `parseError` field for that file rather than trusting its (empty) component list. |

## Files

- `scripts/extract.mjs` — the driver described above (self-contained; only
  dependency is the vendored `scripts/node_modules/acorn`).
- `example/vite-app/` — Vite-style fixture (import graph, Options API,
  a `<script setup>` component mixed in, one deliberately-unresolvable tag).
- `example/cdn-app/` — CDN-style fixture (`<script src>` graph, global
  `Vue.component()` registration, HTML-markup component usage).
- `example/output/` — real, committed output from analyzing both fixtures
  together in one run — use it as a reference for the output shape.
