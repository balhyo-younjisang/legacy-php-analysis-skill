# Specification (derived from static analysis + comments)

Assembled mechanically from the AST and doc comments of every file/component reachable from the entry point(s) below (import graph + `<script src>`/inline graph + template `renders` edges). States only what the code and its comments show - gaps are called out explicitly, not filled in.

## Entry point: `vite-app/src/main.js`

### Files loaded by this page

- `vite-app/src/main.js`
- `vite-app/src/App.vue`
- `vite-app/src/components/HelloWorld.vue`
- `vite-app/src/components/CompositionWidget.vue`

### Components rendered (including via template usage)

_None beyond the files already listed above._

### Props (inputs)

- `vite-app/src/components/HelloWorld.vue` — `HelloWorld.name`: String (required)

### External state read (route/store/window/props actually accessed in code)

- `prop:name`

### Emitted events (outputs)

- `vite-app/src/App.vue` — `App`: **"app-greeted"** (from `onGreet`)
- `vite-app/src/components/HelloWorld.vue` — `HelloWorld`: **greet** (declared via `emits`)
- `vite-app/src/components/HelloWorld.vue` — `HelloWorld`: **"greet"** (from `mounted`)

### External I/O (HTTP calls, store dispatch/commit, storage) - reachable from this page only

- `vite-app/src/App.vue` — `App.refresh`: **http:get** — "/api/products"
- `vite-app/src/App.vue` — `App.refresh`: **store:dispatch** — "cart/sync"

### Documented contracts (from JSDoc comments)

- **component `HelloWorld`** (`vite-app/src/components/HelloWorld.vue`):

  > Simple greeting banner. Emits "greet" once mounted.

- **method `App.refresh`** (`vite-app/src/App.vue`):

  > Reload the product list from the API.
  > @returns {Promise<void>}

- **computed `App.productCount`** (`vite-app/src/App.vue`):

  > Number of loaded products.

### Gaps — no formal JSDoc (4)

- lifecycle `App.created` in `vite-app/src/App.vue`
- method `App.onGreet` in `vite-app/src/App.vue` (informal note only: "no docblock on purpose - a Spec gap")
- component `App` in `vite-app/src/App.vue`
- lifecycle `HelloWorld.mounted` in `vite-app/src/components/HelloWorld.vue`

### ⚠️ Unresolved (reachable from this page)

- `vite-app/src/App.vue` — renders: `UnknownWidget`

## Entry point: `cdn-app/legacy.html`

### Files loaded by this page

- `cdn-app/legacy.html`
- `cdn-app/widgets/counter.js`
- `cdn-app/legacy.html#inline-1`

### Components rendered (including via template usage)

_None beyond the files already listed above._

### Props (inputs)

- `cdn-app/widgets/counter.js` — `counter.start`: Number = 0

### External state read (route/store/window/props actually accessed in code)

_None detected._

### Emitted events (outputs)

- `cdn-app/widgets/counter.js` — `counter`: **"counted"** (from `increment`)

### External I/O (HTTP calls, store dispatch/commit, storage) - reachable from this page only

- `cdn-app/legacy.html` — `(root app).onCounted`: **http:fetch** — '/api/log?count=' + n

### Documented contracts (from JSDoc comments)

- **component `counter`** (`cdn-app/widgets/counter.js`):

  > Global "counter" widget, registered on the CDN build of Vue.
  > Legacy pattern: no bundler, no SFC - just Vue.component() + a template string.

- **method `(root app).onCounted`** (`cdn-app/legacy.html`):

  > Handle the "counted" event bubbled up from <counter>.

- **method `counter.increment`** (`cdn-app/widgets/counter.js`):

  > Increment the click counter and tell the page about it.

### Gaps — no formal JSDoc (1)

- component `(root app)` in `cdn-app/legacy.html`

### Defined but not called from this page (1)

Present in a component this page loads, but no call was found in the static call graph (script calls + template event bindings) - likely used only by other pages, or dead code.

- `counter.reset` in `cdn-app/widgets/counter.js`

