# Dependency Graph

File/component graph: ES `import`/dynamic `import()` (Vite), `<script src>`/inline `<script>` (CDN HTML), and `renders` edges (a template's custom-tag usage resolved to the file defining that component). Paths relative to `/Users/yunjisang/Workspace/krmedics/legacy-php-skills/vue-analysis/example`.

## Entry points

- `vite-app/src/main.js`
- `cdn-app/legacy.html`

## File graph (Mermaid)

```mermaid
flowchart TD
  n2074023579["vite-app/src/main.js"]
  n2035415072["vite-app/src/App.vue"]
  n2074023579 -->|"import"| n2035415072
  n158423623["cdn-app/legacy.html"]
  n1324690766["cdn-app/widgets/counter.js"]
  n158423623 -->|"script-src"| n1324690766
  n1038594681["cdn-app/legacy.html#inline-1"]
  n158423623 -->|"inline-script"| n1038594681
  n155288392["vite-app/src/components/HelloWorld.vue"]
  n2035415072 -->|"import"| n155288392
  n581461990["vite-app/src/components/CompositionWidget.vue"]
  n2035415072 -->|"import"| n581461990
  n158423623 -.->|"renders"| n1324690766
  n2035415072 -.->|"renders"| n155288392
  n2035415072 -.->|"renders"| n581461990
  n107332296["⚠️ UNRESOLVED (renders): UnknownWidget"]
  n2035415072 -.->|"renders (unresolved)"| n107332296
  n1386697385["📦 external: vue"]
  n2074023579 -->|"import (external)"| n1386697385
  n1782996750["📦 external: https://unpkg.com/vue@3"]
  n158423623 -->|"script-src (external)"| n1782996750
  n1195622393["📦 external: axios"]
  n2035415072 -->|"import (external)"| n1195622393
  n581461990 -->|"import (external)"| n1386697385
```

## Edges (detail)

| From | To | Type |
|---|---|---|
| `vite-app/src/main.js` | `vite-app/src/App.vue` | import |
| `cdn-app/legacy.html` | `cdn-app/widgets/counter.js` | script-src |
| `cdn-app/legacy.html` | `cdn-app/legacy.html#inline-1` | inline-script |
| `vite-app/src/App.vue` | `vite-app/src/components/HelloWorld.vue` | import |
| `vite-app/src/App.vue` | `vite-app/src/components/CompositionWidget.vue` | import |
| `cdn-app/legacy.html` | `cdn-app/widgets/counter.js` | renders |
| `vite-app/src/App.vue` | `vite-app/src/components/HelloWorld.vue` | renders |
| `vite-app/src/App.vue` | `vite-app/src/components/CompositionWidget.vue` | renders |

## 📦 External packages / CDN URLs (4)

Not part of this project's own file graph - expected, not a gap.

- `vite-app/src/main.js` — import: `vue`
- `cdn-app/legacy.html` — script-src: `https://unpkg.com/vue@3`
- `vite-app/src/App.vue` — import: `axios`
- `vite-app/src/components/CompositionWidget.vue` — import: `vue`

## ⚠️ Unresolved (1)

Could not be statically resolved to a file/component - a computed import path, a dynamic `<component :is>`, or a template tag with no matching local/global component definition found.

- `vite-app/src/App.vue` — renders: `UnknownWidget`
