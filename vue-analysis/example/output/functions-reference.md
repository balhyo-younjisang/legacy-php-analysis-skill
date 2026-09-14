# Components & Methods Reference

One entry per Options-API component definition found while walking the file graph, with its props/data/emits, each method/computed/watcher/lifecycle hook's doc comment (or ⚠️ its absence), and facts pulled from static analysis (calls, external reads, I/O, outputs).

## `cdn-app/legacy.html`

### `(root app)` _(root app instance)_

- **File:** `cdn-app/legacy.html`:4
- **Data fields:** `total`

> ⚠️ No doc comment found for this component.

**Methods:**

- `onCounted(n)` — Handle the "counted" event bubbled up from <counter>. _(External I/O: `http:fetch('/api/log?count=' + n)`)_

## `vite-app/src/App.vue`

### `App`

- **File:** `vite-app/src/App.vue`:6
- **Data fields:** `userName`, `products`
- **Child components:** `HelloWorld`, `CompositionWidget`

> ⚠️ No doc comment found for this component.

**Lifecycle hooks:**

- `created()` ⚠️ no doc _(Calls: `refresh`)_

**Methods:**

- `refresh()` — Reload the product list from the API. _(External I/O: `http:get("/api/products")`, `store:dispatch("cart/sync")`)_
- `onGreet(payload)` — _(informal note)_ no docblock on purpose - a Spec gap _(Outputs: `console:log`, `emit:"app-greeted"`)_

**Computed:**

- `productCount()` — Number of loaded products.

## `cdn-app/widgets/counter.js`

### `counter` _(global, `Vue.component`)_

- **File:** `cdn-app/widgets/counter.js`:5
- **Props:** `start: Number`
- **Data fields:** `count`

> Global "counter" widget, registered on the CDN build of Vue.
> Legacy pattern: no bundler, no SFC - just Vue.component() + a template string.

**Methods:**

- `increment()` — Increment the click counter and tell the page about it. _(Outputs: `emit:"counted"`)_
- `reset()` — _(informal note)_ undocumented on purpose

## `vite-app/src/components/HelloWorld.vue`

### `HelloWorld`

- **File:** `vite-app/src/components/HelloWorld.vue`:5
- **Props:** `name: String (required)`
- **Declared emits:** `greet`

> Simple greeting banner. Emits "greet" once mounted.

**Lifecycle hooks:**

- `mounted()` ⚠️ no doc _(Outputs: `emit:"greet"`)_

---

**Coverage:** 6/12 components/methods/computed/watchers/lifecycle hooks have a formal JSDoc (`/** */`) comment in source.
