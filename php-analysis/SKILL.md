---
name: php-analysis
description: Statically analyze legacy PHP (PHP 8 and below, procedural include/require-style) codebases. Follows include/require/include_once/require_once chains recursively across files to reconstruct what one "page" actually is, extracts every function/class/method with its PHPDoc, builds a Spec document (inputs, outputs, DB access, documented contracts, gaps) from static analysis + comments, and writes perspective-driven review docs (security, data-flow, business-rule, etc.) on request. Use when asked to document, review, audit, or write a spec for old/legacy PHP code, or to explain how a tangle of included PHP files produces one page.
---

# php-analysis

Legacy PHP pages are rarely one file - `index.php` pulls in `config.php`,
`inc/header.php`, `inc/functions.php`, sometimes conditionally, sometimes via
a path built from a constant or a variable. You cannot understand "the page"
by reading one file. This skill's driver (`scripts/extract.mjs`) parses a
**real PHP AST** (via the vendored `php-parser` npm package - no PHP runtime
needed) starting from one or more entry files, follows every include/require
it can resolve, and emits structured facts plus three Markdown reports. You
then read those facts and write the actual analysis/spec/perspective
document the user asked for - **never skip straight to writing docs by
eyeballing the source**; the extractor exists because eyeballing misses
included files, misattributes conditional code as unconditional, and can't
tell a real PHPDoc block from an unrelated stray comment.

If the page also loads Vue 3 (Options API, either via CDN `<script src>`
globals or a Vite-built bundle) alongside the PHP-rendered markup, use the
sibling `vue-analysis` skill (`../vue-analysis/SKILL.md`) for that half —
same output shape (facts.json/dependency-graph.md/functions-reference.md/
SPEC.md), same "extract facts, then write the doc" division of labor.

Paths below are relative to this skill's directory, `php-analysis/`, unless
said otherwise. When used as a Claude Code skill, copy or symlink this whole
directory into a project's `.claude/skills/php-analysis/`.

## Run (agent path)

```bash
node scripts/extract.mjs <entry.php> [<entry2.php> ...] --out <outdir> [--root <projectRoot>]
```

- One `--out` directory holds everything for **all** entry points passed in
  one run (files shared between pages, like `config.php`, are analyzed
  once). Pass every page of the site you're documenting together when they
  share files - that's what lets the tool report "defined but never called
  from THIS page" per entry instead of dumping everything into every page.
- `--root` is the project root used to resolve legacy "docroot-absolute"
  includes like `include('/inc/db.php')` (interpreted as `<root>/inc/db.php`,
  not a real filesystem path) and to scope the `define()`/`const` pre-scan
  used to resolve path constants. Default: the common parent directory of
  the entry files. Set it explicitly if your entry files live deep in a
  subdirectory but constants are defined nearer the real project root.
- No `npm install` needed - `php-parser` is vendored under
  `scripts/node_modules/`.

Verified end-to-end against the fixture in `example/app/` (a tiny multi-file
legacy shop app: `index.php` + `cart.php` sharing `config.php` and
`inc/functions.php`, with a class, conditional include, and one genuinely
dynamic include built from `$_GET['tab']`):

```bash
node scripts/extract.mjs example/app/index.php example/app/cart.php \
  --out example/output --root example/app
```

```
Analyzed 8 file(s), 7 function/class/method entities.
Unresolved/dynamic includes: 1
Output written to: .../example/output
```

`example/output/` is the real, committed output of that run - read it to see
the exact shape before using this on a real codebase.

### Output files (in `--out`)

| File | Contents |
|---|---|
| `facts.json` | Everything: per-file functions/classes/methods (params, PHPDoc, calls made, superglobals touched, SQL literals, outputs), the include graph (edges, resolved/dynamic), resolved constants. This is the ground truth - read it before writing any narrative. |
| `dependency-graph.md` | Mermaid flowchart of the file graph per entry point, plus an edge table and a called-out list of unresolved/dynamic includes. |
| `functions-reference.md` | One entry per function/class/method: signature + PHPDoc (or "⚠️ no PHPDoc", clearly distinguished from an informal `//` note) + static facts. A coverage line at the end. |
| `SPEC.md` | Per entry point: included files (flagging which are only conditionally pulled in), inputs (superglobals actually reachable), outputs/side effects and DB access **restricted to code the static call graph shows actually runs for that page** (not just "defined in a file this page happens to include"), documented contracts verbatim from PHPDoc, an explicit gaps list, a "defined but not called from this page" list, and unresolved-include warnings. |

### Writing the documentation the user actually asked for

The script only extracts and organizes facts - it does not write prose. After
running it:

1. Read `facts.json` (and the three `.md` files - they're easier to skim)
   for the entry point(s) in question.
2. Write the requested document grounded in those facts only. Examples:
   - **"이 페이지 보안 관점으로 문서 써줘" (security perspective):** walk
     `SPEC.md`'s Inputs/Outputs/Database sections, flag unsanitized
     superglobal → SQL string-concatenation paths (`facts.json`'s per-entity
     `sql`/`superglobals` make these traceable), call out every unresolved
     dynamic include as an unaudited surface.
   - **"데이터 흐름 관점" (data-flow):** trace superglobal reads →
     function calls (`calls` arrays) → SQL/output, using the call graph in
     `facts.json`, one page at a time.
   - **"업무 로직 설명" (business-rule summary):** lean on `Documented
     contracts` in `SPEC.md` for anything with a real PHPDoc, and mark
     everything in the Gaps section as "not confirmed by comments - inferred
     from code" so the reader knows which parts are your inference vs. the
     original author's stated intent.
   - **Per-function description doc:** `functions-reference.md` is already
     that; add narrative framing around it if asked for prose instead of a
     reference table.
3. Never state something as the page's behavior that the tool marked
   dynamic/unresolved or "defined but not called" without saying so
   explicitly - that's the entire point of running the extractor instead of
   skimming the source by eye.

## Direct invocation (no full report - just the facts)

For a quick one-off question ("does this page touch `$_SESSION`?"), run the
extractor and grep `facts.json` / `SPEC.md` rather than writing a new
analysis path:

```bash
node scripts/extract.mjs path/to/entry.php --out /tmp/pa && grep -A3 '"superglobals"' /tmp/pa/facts.json
```

## Gotchas

- **A leading `//` or `/* */` comment is not a PHPDoc block.** The tool only
  counts a real `/** ... */` block as "formal" documentation (see
  `functions-reference.md`'s coverage line and `SPEC.md`'s gap list). An
  informal note is still surfaced in the reference doc, just never treated
  as a documented contract - legacy code leans on stray `//` notes a lot,
  and conflating them with real docblocks was the first bug found while
  building this (see `example/app/inc/functions.php`'s `format_price`).
- **"Defined in an included file" ≠ "runs on this page."** A function only
  shows up in a page's `SPEC.md` Outputs/Database sections if the static
  call graph, starting from that page's own top-level statements, actually
  reaches it. Otherwise it lands in "Defined but not called from this page."
  Verified with `cart.php` in the fixture, which shares `inc/functions.php`
  with `index.php` but never calls `get_product_name`/`log_page_view` -
  those correctly disappear from `cart.php`'s SQL/output sections and
  reappear under "Defined but not called."
- **Method calls (`$obj->method()`, `Class::method()`) are not resolved** -
  no type inference is attempted. A class's methods are always listed if its
  file is reachable, so class-method side effects can be over-reported
  relative to whether the method is actually invoked. Say so when writing a
  perspective doc instead of silently trusting the method list as "runs."
- **Path constants defined as `dirname(__FILE__)`/`__DIR__`, not string
  literals, resolve fine** - the constant pre-scan evaluates those (and
  chains of one constant built from another) before the include graph is
  walked, in up to 3 passes. A constant computed by anything else (a
  function call other than `dirname`, a value read from a config file, an
  environment variable) does not resolve and the include shows up
  "UNRESOLVED" - that's correct, not a bug; go read it manually.
- **Conditional includes propagate.** A file only pulled in from inside an
  `if`/`switch`/loop is marked `(conditionally included)` in `SPEC.md`, and
  everything that file's top level does inherits that flag - see
  `inc/admin_panel.php` in the fixture.
- **`--root`** is about legacy docroot-absolute paths
  (`include('/inc/db.php')` meaning site-root-relative, not filesystem-root).
  If you don't pass it, it defaults to the entry files' common parent
  directory, which is usually right for a single app rooted at that
  directory.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `TypeError: Cannot read properties of undefined (reading 'push')` from inside `analyzeFile` | Hit while developing this tool: a per-file "page" entity object was missing a field another code path assumed existed. If you see something like this after editing `extract.mjs`, check that every place constructing an entity object includes the same fields as `makeEntity()`. |
| An `include`/`require` you know is static shows up as UNRESOLVED | Its target isn't one of: a string literal, `__DIR__`/`__FILE__`/`dirname(__FILE__)`, string concatenation of those, or a `define()`d/`const` constant resolvable from the pre-scan. Anything else (a variable, a function call other than `dirname`, ternaries) is intentionally left dynamic rather than guessed at. |
| Same SQL literal appears twice for one function | Already fixed in this driver (a literal passed straight to `mysqli_query()`-style calls was matched by both the generic SQL-literal scan and the call-argument scan; entries are now deduped by source line before being reported) - if you see it recur after editing `extract.mjs`, check the dedupe block right after the AST walk in `analyzeFile`. |

## Files

- `scripts/extract.mjs` - the driver described above (self-contained; only
  dependency is the vendored `scripts/node_modules/php-parser`).
- `example/app/` - the fixture used to verify every claim in this file.
- `example/output/` - real, committed output from running the driver against
  that fixture (two entry points, one run) - use it as a reference for the
  output shape.
