#!/usr/bin/env node
/**
 * vue-analysis extractor
 * -----------------------
 * Static-analysis driver for Vue 3 Options API code in BOTH of the two
 * legacy-adjacent shapes it tends to show up in:
 *  - Vite/SFC/ESM: `.vue` single-file components wired together with
 *    `import`/`export` statements (main.js -> App.vue -> child .vue files).
 *  - CDN/global: a plain `.html` page loading Vue and one or more plain
 *    `.js` files via `<script src>`, registering components globally with
 *    `Vue.component('name', {...})` and referencing them by tag name
 *    straight in HTML markup - no bundler, no imports at all.
 *
 * Given one or more entry files (an .html page, or a Vite entry .js/.vue),
 * it:
 *  1. Follows the file graph: ES `import`/dynamic `import()` for Vite,
 *     `<script src>` + inline `<script>` blocks for HTML. Anything it
 *     can't resolve statically (a bare npm package, a computed import
 *     path, an external CDN URL) is reported, not silently dropped.
 *  2. Parses every reachable file with a real JS parser (acorn, vendored
 *     in scripts/node_modules) and, for each recognized Options-API
 *     component definition (`export default {...}`, `defineComponent({...})`,
 *     `Vue.createApp({...})`, `Vue.component('x', {...})`, `Vue.extend({...})`),
 *     extracts props/data/computed/methods/watch/emits/lifecycle hooks with
 *     their doc comments, plus calls, external-state reads ($route/$store/
 *     props/window), outward side effects ($emit, axios/fetch/$http, store
 *     commit/dispatch), and a best-effort call graph (including calls made
 *     straight from template event bindings like `@click="refresh"`).
 *  3. Resolves which child component each template renders - via local
 *     `components: {}` + `import` bindings for Vite, or via a page-wide
 *     registry of `Vue.component()` names for CDN pages - so the file
 *     graph reflects "what this page actually renders", not just imports.
 *  4. Emits the same four artifacts as the php-analysis skill: facts.json,
 *     dependency-graph.md, functions-reference.md, SPEC.md.
 *
 * This script only extracts and organizes FACTS. Writing documentation
 * from a user-requested "perspective" is a reasoning task for the calling
 * agent - see SKILL.md.
 *
 * Usage:
 *   node extract.mjs <entry> [<entry2> ...] [--out DIR] [--root DIR]
 *
 *   Entries may be .html, .js/.mjs, or .vue files, mixed freely.
 *   --root scopes relative-path display and the CDN global-component scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI -----

function parseArgs(argv) {
  const entries = [];
  let out = 'vue-analysis-out';
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--root') root = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('-')) entries.push(a);
    else { console.error(`Unknown flag: ${a}`); process.exit(1); }
  }
  if (entries.length === 0) { printHelp(); process.exit(1); }
  return { entries: entries.map((e) => path.resolve(e)), out: path.resolve(out), root: root ? path.resolve(root) : null };
}

function printHelp() {
  console.log('Usage: node extract.mjs <entry.html|entry.js|entry.vue> [...] [--out DIR] [--root DIR]');
}

// ------------------------------------------------------------- constants ---

const LIFECYCLE_KEYS = new Set([
  'created', 'beforeCreate', 'mounted', 'beforeMount', 'beforeUpdate', 'updated',
  'beforeUnmount', 'unmounted', 'beforeDestroy', 'destroyed', 'activated', 'deactivated', 'errorCaptured',
]);
const OPTIONS_HINT_KEYS = new Set(['data', 'methods', 'computed', 'props', 'emits', 'watch', 'components', 'setup', 'template', ...LIFECYCLE_KEYS]);
const CONTAINER_KEYS = new Set(['methods', 'computed', 'watch']);

// A deliberately small allowlist of native HTML tags, used only to decide
// whether a tag found in a template is a Vue component candidate worth
// trying to resolve - NOT an exhaustive HTML spec list.
const HTML_TAGS = new Set([
  'a','abbr','address','area','article','aside','audio','b','base','bdi','bdo','blockquote','body','br',
  'button','canvas','caption','cite','code','col','colgroup','data','datalist','dd','del','details','dfn',
  'dialog','div','dl','dt','em','embed','fieldset','figcaption','figure','footer','form','h1','h2','h3','h4',
  'h5','h6','head','header','hr','html','i','iframe','img','input','ins','kbd','label','legend','li','link',
  'main','map','mark','meta','meter','nav','noscript','object','ol','optgroup','option','output','p','param',
  'picture','pre','progress','q','rp','rt','ruby','s','samp','script','section','select','slot','small',
  'source','span','strong','style','sub','summary','sup','table','tbody','td','template','textarea','tfoot',
  'th','thead','time','title','tr','track','u','ul','var','video','wbr','transition','transition-group',
  'keep-alive', 'component',
]);

// ------------------------------------------------------------- helpers ----

function sliceSrc(src, node, max = 160) {
  if (!node || node.start == null) return null;
  const s = src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Nearest contiguous run of comments immediately preceding `nodeStart`
 *  (only whitespace between them and the node / each other). Mirrors
 *  php-analysis's leading-comment logic, hand-rolled because acorn (unlike
 *  php-parser) doesn't attach comments to nodes itself. */
function docFor(comments, src, nodeStart) {
  let i = comments.length - 1;
  while (i >= 0 && comments[i].end > nodeStart) i--;
  const attached = [];
  let cursor = nodeStart;
  while (i >= 0) {
    const c = comments[i];
    const between = src.slice(c.end, cursor);
    if (!/^\s*$/.test(between)) break;
    attached.unshift(c);
    cursor = c.start;
    i--;
  }
  if (attached.length === 0) return null;
  const formal = attached.some((c) => c.block && c.text.startsWith('*'));
  const text = attached
    .map((c) => (c.block ? c.text.replace(/^\*/, '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd()).join('\n') : c.text))
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n') || null;
  return text ? { text, formal } : null;
}

function keyName(prop) {
  if (!prop || !prop.key) return null;
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

function calleeDotPath(node) {
  // Renders `foo.bar.baz` for a MemberExpression chain, or an Identifier name.
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) {
    const obj = calleeDotPath(node.object);
    const prop = node.property.type === 'Identifier' ? node.property.name : null;
    return obj && prop ? `${obj}.${prop}` : null;
  }
  return null;
}

function literalOrText(node, src) {
  if (!node) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'string' ? JSON.stringify(node.value) : String(node.value);
  return sliceSrc(src, node, 40);
}

function paramSig(p, src) {
  switch (p.type) {
    case 'Identifier': return p.name;
    case 'AssignmentPattern': return `${paramSig(p.left, src)} = ${sliceSrc(src, p.right, 30)}`;
    case 'RestElement': return `...${paramSig(p.argument, src)}`;
    case 'ObjectPattern': return '{ ' + p.properties.map((pr) => pr.key?.name ?? '…').join(', ') + ' }';
    case 'ArrayPattern': return '[ ' + p.elements.map((el) => (el ? paramSig(el, src) : '')).join(', ') + ' ]';
    default: return '…';
  }
}

// ---------------------------------------------------------- generic walk --

/** Same shape as php-analysis's walker: recurse into every object/array,
 *  and for anything with a `.type`, call cb(node, ctx) which may return a
 *  new ctx used for that node's own subtree. */
function walk(node, ctx, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, ctx, cb); return; }
  if (!node.type) { for (const k of Object.keys(node)) walk(node[k], ctx, cb); return; }
  const nextCtx = cb(node, ctx) || ctx;
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    walk(node[k], nextCtx, cb);
  }
}

const CONDITIONAL_TYPES = new Set(['IfStatement', 'ConditionalExpression', 'SwitchStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'TryStatement', 'LogicalExpression']);

/** Walk one function/method body collecting calls / external reads / IO /
 *  outputs into `entity`, using the same recognized-pattern allowlists the
 *  whole tool relies on (mirrors php-analysis's SQL_FUNCS/OUTPUT_FUNCS). */
function walkEntityBody(bodyNode, entity, src, propNames) {
  walk(bodyNode, { conditional: false }, (node, ctx) => {
    let nextCtx = ctx;
    if (CONDITIONAL_TYPES.has(node.type)) nextCtx = { ...ctx, conditional: true };

    if (node.type === 'CallExpression') {
      const path = calleeDotPath(node.callee);
      if (path) {
        let recognized = true;
        if (path === 'this.$emit' && node.arguments[0]) {
          entity.outputs.push({ kind: 'emit', event: literalOrText(node.arguments[0], src), line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else if (path === 'this.$store.dispatch' || path === 'this.$store.commit') {
          entity.io.push({ kind: path.endsWith('dispatch') ? 'store:dispatch' : 'store:commit', target: node.arguments[0] ? literalOrText(node.arguments[0], src) : null, line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else if (path === 'fetch') {
          entity.io.push({ kind: 'http:fetch', target: node.arguments[0] ? literalOrText(node.arguments[0], src) : null, line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else if (/^axios\.(get|post|put|delete|patch|request)$/.test(path) || /^this\.\$http\.(get|post|put|delete|patch|request)$/.test(path)) {
          entity.io.push({ kind: `http:${path.split('.').pop()}`, target: node.arguments[0] ? literalOrText(node.arguments[0], src) : null, line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else if (path === 'useStore' || path === 'useRoute' || path === 'useRouter') {
          entity.io.push({ kind: `composable:${path}`, target: null, line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else if (/^(localStorage|sessionStorage)\.(setItem|removeItem|clear)$/.test(path)) {
          entity.io.push({ kind: `storage:${path.split('.').pop()}`, target: node.arguments[0] ? literalOrText(node.arguments[0], src) : null, line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else if (/^console\.(log|warn|error|info|debug)$/.test(path)) {
          entity.outputs.push({ kind: 'console', event: path.split('.').pop(), line: line(node), conditional: ctx.conditional, text: sliceSrc(src, node) });
        } else {
          recognized = false;
        }
        // The call graph (used for cross-method/lifecycle reachability, see
        // computeCalledNames) only tracks calls that can plausibly name
        // another locally-defined method: a bare identifier, or `this.foo()`
        // with nothing further after `foo`. A recognized io/output pattern
        // (axios.get, this.$emit, console.log, ...) is already captured
        // above with a far more useful label than its bare last segment -
        // recording it again under `calls` would just be noise (and for
        // "get"/"dispatch"/"log" style last segments, actively misleading).
        if (!recognized) {
          if (!path.includes('.')) entity.calls.push(path);
          else if (path.startsWith('this.') && !path.slice(5).includes('.')) entity.calls.push(path.slice(5));
        }
      }
    } else if (node.type === 'MemberExpression' && !node.computed) {
      const dp = calleeDotPath(node);
      if (dp) {
        if (dp === 'this.$route' || dp.startsWith('this.$route.')) entity.externalReads.add(dp.replace(/^this\./, ''));
        else if (dp === 'this.$router') entity.externalReads.add('$router');
        else if (dp.startsWith('this.$store.state.') || dp.startsWith('this.$store.getters.')) entity.externalReads.add(dp.replace(/^this\./, ''));
        else if (dp.startsWith('window.')) entity.externalReads.add(dp);
        else if (dp.startsWith('document.')) entity.externalReads.add(dp);
        else if (dp.startsWith('this.') && propNames && propNames.has(dp.slice(5))) entity.externalReads.add(`prop:${dp.slice(5)}`);
        else if (dp === 'localStorage.getItem' || dp === 'sessionStorage.getItem') entity.externalReads.add(dp);
      }
    } else if (node.type === 'MemberExpression' && node.computed && node.object?.type === 'ThisExpression' && propNames) {
      // this['propName'] / this[propName] - only the literal-string form is resolvable.
      if (node.property?.type === 'Literal' && propNames.has(String(node.property.value))) {
        entity.externalReads.add(`prop:${node.property.value}`);
      }
    }

    return nextCtx;
  });
}

function line(node) { return node.loc ? node.loc.start.line : null; }

function makeCallEntity(kind, name, node) {
  return { entityKind: kind, name, line: line(node), doc: null, params: undefined, calls: [], externalReads: new Set(), io: [], outputs: [] };
}

// -------------------------------------------------------- SFC / HTML split --

function splitVueSFC(src) {
  const blocks = { template: null, scripts: [] };
  const templateMatch = src.match(/<template(?:\s[^>]*)?>([\s\S]*?)<\/template>/);
  if (templateMatch) blocks.template = { text: templateMatch[1], offset: templateMatch.index + templateMatch[0].indexOf(templateMatch[1]) };
  const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = scriptRe.exec(src))) {
    const attrs = m[1] || '';
    blocks.scripts.push({ text: m[2], setup: /\bsetup\b/.test(attrs), offset: m.index + m[0].indexOf(m[2]) });
  }
  return blocks;
}

function extractHtmlScripts(src) {
  const scripts = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    const srcAttr = attrs.match(/\bsrc=["']([^"']+)["']/);
    scripts.push({
      raw: m[0], attrs, src: srcAttr ? srcAttr[1] : null,
      module: /\btype=["']module["']/.test(attrs),
      text: srcAttr ? null : m[2],
      textOffset: m.index + m[0].indexOf(m[2]),
    });
  }
  return { scripts };
}

/** HTML markup with every <script>...</script> body blanked out, so a
 *  custom-tag scan of the page's real markup can't be fooled by a Vue
 *  template STRING that happens to live inside a <script> block. */
function htmlBodyWithoutScripts(src) {
  return src.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs) => `<script${attrs}></script>`);
}

// ---------------------------------------------------- component tag scan --

function scanComponentTags(templateText) {
  if (!templateText) return [];
  const tags = new Set();
  const re = /<\/?([A-Za-z][A-Za-z0-9-]*)/g;
  let m;
  while ((m = re.exec(templateText))) {
    const raw = m[1];
    if (!HTML_TAGS.has(raw.toLowerCase())) tags.add(raw);
  }
  // :is="literal" dynamic-component bindings, resolvable only when literal.
  const isRe = /<component\b[^>]*:is="([^"]*)"/g;
  while ((m = isRe.exec(templateText))) {
    const expr = m[1].trim();
    const litMatch = expr.match(/^['"]([^'"]+)['"]$/);
    if (litMatch) tags.add(litMatch[1]);
    else tags.add(`__dynamic__:${expr}`);
  }
  return [...tags];
}

function kebabToPascal(name) {
  return name.replace(/(^\w|-\w)/g, (s) => s.replace('-', '').toUpperCase());
}

/** @click="handler(...)" / v-on:evt="handler" - best-effort extraction of
 *  every identifier-call-shaped handler name bound directly in a template,
 *  used to seed the component's own call graph (an event handler with no
 *  other caller in the script still genuinely runs). */
function scanTemplateCalls(templateText) {
  if (!templateText) return [];
  const calls = [];
  const re = /(?:@|v-on:)[a-zA-Z0-9_-]+="([^"]*)"/g;
  let m;
  while ((m = re.exec(templateText))) {
    const expr = m[1];
    const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(expr))) calls.push(cm[1]);
    if (!/\(/.test(expr) && /^[A-Za-z_$][\w$]*$/.test(expr.trim())) calls.push(expr.trim());
  }
  return calls;
}

// ------------------------------------------------------------- resolution --

function resolveModulePath(source, currentFile, root) {
  if (!source.startsWith('.') && !source.startsWith('/')) return { external: true, source };
  const base = source.startsWith('/') ? path.join(root || path.dirname(currentFile), source.replace(/^\/+/, '')) : path.resolve(path.dirname(currentFile), source);
  const candidates = [base, base + '.js', base + '.mjs', base + '.ts', base + '.vue', path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { path: c };
  }
  return { unresolved: true, source };
}

// --------------------------------------------------------- component parse --

function parseWithAcorn(code) {
  const comments = [];
  const ast = Parser.parse(code, {
    ecmaVersion: 2022,
    sourceType: 'module',
    locations: true,
    allowImportExportEverywhere: true,
    onComment: (block, text, start, end) => comments.push({ block, text, start, end }),
  });
  return { ast, comments };
}

function isDefineComponentCall(node) {
  return node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'defineComponent' && node.arguments[0]?.type === 'ObjectExpression';
}

/** Extract every Options-API component object from one file's script AST,
 *  plus its import list (for the file graph) and any template-derived
 *  facts merged in by the caller (SFC template block / HTML body). */
function analyzeScript(code, filePath) {
  let ast, comments;
  try { ({ ast, comments } = parseWithAcorn(code)); }
  catch (e) { return { parseError: String(e.message || e), imports: [], components: [] }; }

  const imports = [];
  const components = [];

  function objectHasOptionsKey(obj) {
    return obj.properties.some((p) => p.type === 'Property' && OPTIONS_HINT_KEYS.has(keyName(p)));
  }

  function registerComponent(objNode, docAnchorNode, nameHint, extra = {}) {
    const comp = buildComponentEntity(objNode, code, comments, docAnchorNode, nameHint, extra);
    components.push(comp);
    return comp;
  }

  walk(ast, {}, (node) => {
    if (node.type === 'ImportDeclaration') {
      imports.push({ source: node.source.value, line: line(node), specifiers: node.specifiers.map((s) => ({ local: s.local.name, imported: s.imported?.name ?? 'default' })) });
    } else if (node.type === 'ImportExpression') {
      const arg = node.source;
      imports.push({ source: arg?.type === 'Literal' ? arg.value : null, dynamic: true, line: line(node), raw: arg?.type !== 'Literal' ? sliceSrc(code, arg, 80) : null });
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      if (d.type === 'ObjectExpression') registerComponent(d, node, '(default export)');
      else if (isDefineComponentCall(d)) registerComponent(d.arguments[0], node, '(default export)');
    } else if (node.type === 'VariableDeclarator' && node.init) {
      if (node.init.type === 'ObjectExpression' && objectHasOptionsKey(node.init)) {
        registerComponent(node.init, node, node.id?.name ?? '(anonymous)');
      } else if (isDefineComponentCall(node.init)) {
        registerComponent(node.init.arguments[0], node, node.id?.name ?? '(anonymous)');
      }
    } else if (node.type === 'CallExpression') {
      const path = calleeDotPath(node.callee);
      if (path === 'Vue.createApp' && node.arguments[0]?.type === 'ObjectExpression') {
        registerComponent(node.arguments[0], node.arguments[0], '(root app)', { isRoot: true });
      } else if (path === 'Vue.extend' && node.arguments[0]?.type === 'ObjectExpression') {
        registerComponent(node.arguments[0], node.arguments[0], '(Vue.extend component)');
      } else if (path === 'Vue.component' && node.arguments[0]?.type === 'Literal' && node.arguments[1]?.type === 'ObjectExpression') {
        registerComponent(node.arguments[1], node, node.arguments[0].value, { globalRegistration: true });
      }
    } else if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'Vue' && node.arguments[0]?.type === 'ObjectExpression') {
      registerComponent(node.arguments[0], node, '(root app - new Vue)', { isRoot: true });
    }
  });

  return { imports, components };
}

function buildComponentEntity(objNode, code, comments, docAnchorNode, nameHint, extra) {
  const comp = {
    entityKind: 'component',
    name: nameHint,
    line: line(objNode),
    doc: docFor(comments, code, docAnchorNode.start),
    props: [],
    dataFields: [],
    componentsMap: {},
    declaredEmits: [],
    mixins: [],
    methods: [],
    computed: [],
    watchers: [],
    lifecycle: [],
    calls: [],
    externalReads: new Set(),
    io: [],
    outputs: [],
    templateOption: null,
    ...extra,
  };

  const propNames = new Set();
  for (const p of objNode.properties) {
    if (p.type !== 'Property') continue;
    const key = keyName(p);
    if (key === 'props') {
      if (p.value.type === 'ArrayExpression') {
        for (const el of p.value.elements) if (el?.type === 'Literal') propNames.add(String(el.value));
      } else if (p.value.type === 'ObjectExpression') {
        for (const pp of p.value.properties) { const n = keyName(pp); if (n) propNames.add(n); }
      }
    }
  }

  for (const p of objNode.properties) {
    if (p.type !== 'Property') continue;
    const key = keyName(p);
    if (key == null) continue;

    if (key === 'name' && p.value.type === 'Literal') comp.name = p.value.value;
    else if (key === 'props') comp.props = extractProps(p.value, code);
    else if (key === 'data' && (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression')) comp.dataFields = extractDataFields(p.value);
    else if (key === 'components' && p.value.type === 'ObjectExpression') comp.componentsMap = extractComponentsMap(p.value);
    else if (key === 'emits') comp.declaredEmits = extractEmits(p.value);
    else if (key === 'mixins' && p.value.type === 'ArrayExpression') comp.mixins = p.value.elements.map((e) => (e?.type === 'Identifier' ? e.name : sliceSrc(code, e, 40)));
    else if (key === 'template' && p.value.type === 'Literal') comp.templateOption = p.value.value;
    else if (CONTAINER_KEYS.has(key) && p.value.type === 'ObjectExpression') {
      const kind = key === 'methods' ? 'method' : key === 'computed' ? 'computed' : 'watcher';
      const list = key === 'methods' ? comp.methods : key === 'computed' ? comp.computed : comp.watchers;
      for (const member of p.value.properties) {
        if (member.type !== 'Property') continue;
        const mName = keyName(member);
        let fn = member.value;
        // computed getter/setter form: { get() {}, set(v) {} }
        if (fn.type === 'ObjectExpression') {
          const getter = fn.properties.find((x) => keyName(x) === 'get');
          if (getter) fn = getter.value; else continue;
        }
        const entity = makeCallEntity(kind, mName, member);
        entity.doc = docFor(comments, code, member.start);
        entity.params = fn.params ? fn.params.map((pr) => paramSig(pr, code)) : [];
        if (fn.body) walkEntityBody(fn.body, entity, code, propNames);
        list.push(entity);
      }
    } else if (LIFECYCLE_KEYS.has(key) && (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression')) {
      const entity = makeCallEntity('lifecycle', key, p);
      entity.doc = docFor(comments, code, p.start);
      entity.params = p.value.params.map((pr) => paramSig(pr, code));
      if (p.value.body) walkEntityBody(p.value.body, entity, code, propNames);
      comp.lifecycle.push(entity);
    }
  }

  comp.propNames = [...propNames];
  return comp;
}

function extractProps(node, code) {
  if (node.type === 'ArrayExpression') {
    return node.elements.filter((e) => e?.type === 'Literal').map((e) => ({ name: String(e.value) }));
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.filter((p) => p.type === 'Property').map((p) => {
      const name = keyName(p);
      if (p.value.type === 'ObjectExpression') {
        const typeProp = p.value.properties.find((x) => keyName(x) === 'type');
        const reqProp = p.value.properties.find((x) => keyName(x) === 'required');
        const defProp = p.value.properties.find((x) => keyName(x) === 'default');
        const typeText = typeProp
          ? (typeProp.value.type === 'Identifier' ? typeProp.value.name
            : typeProp.value.type === 'ArrayExpression' ? typeProp.value.elements.map((e) => e.name).join('|')
              : sliceSrc(code, typeProp.value, 30))
          : undefined;
        return { name, type: typeText, required: reqProp?.value?.value === true, default: defProp ? sliceSrc(code, defProp.value, 30) : undefined };
      }
      // shorthand `props: { title: String }`
      return { name, type: p.value.type === 'Identifier' ? p.value.name : sliceSrc(code, p.value, 30) };
    });
  }
  return [];
}

function extractDataFields(fnNode) {
  const body = fnNode.body;
  let retObj = null;
  if (body.type === 'ObjectExpression') retObj = body; // arrow with implicit return of an object needs parens; acorn gives ObjectExpression directly for `() => ({...})`? Actually body is ObjectExpression only if parenthesized - handled below too.
  else if (body.type === 'BlockStatement') {
    const ret = body.body.find((s) => s.type === 'ReturnStatement');
    if (ret?.argument?.type === 'ObjectExpression') retObj = ret.argument;
  }
  if (!retObj) return [];
  return retObj.properties.filter((p) => p.type === 'Property').map((p) => keyName(p)).filter(Boolean);
}

function extractComponentsMap(node) {
  const map = {};
  for (const p of node.properties) {
    if (p.type !== 'Property') continue;
    const local = keyName(p);
    const bindingName = p.value.type === 'Identifier' ? p.value.name : (p.shorthand ? local : null);
    if (local) map[local] = bindingName;
  }
  return map;
}

function extractEmits(node) {
  if (node.type === 'ArrayExpression') return node.elements.filter((e) => e?.type === 'Literal').map((e) => String(e.value));
  if (node.type === 'ObjectExpression') return node.properties.filter((p) => p.type === 'Property').map((p) => keyName(p)).filter(Boolean);
  return [];
}

// -------------------------------------------------------------- per file ---

function analyzeFile(file, root) {
  const ext = path.extname(file);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return { file, missing: true }; }

  if (ext === '.html' || ext === '.htm') return analyzeHtmlFile(file, src, root);
  if (ext === '.vue') return analyzeVueFile(file, src, root);
  return analyzeJsFile(file, src, root);
}

function analyzeJsFile(file, src, root) {
  const result = analyzeScript(src, file);
  if (result.parseError) return { file, kind: 'js', parseError: result.parseError, imports: [], components: [] };
  const rootTags = new Set();
  // A plain .js file has no template of its own, but a component object's
  // `template:` string option can still reference child components.
  for (const c of result.components) {
    for (const t of scanComponentTags(c.templateOption)) rootTags.add(t);
    for (const call of scanTemplateCalls(c.templateOption)) c.calls.push(call);
  }
  return { file, kind: 'js', imports: result.imports, components: result.components, templateTags: [...rootTags] };
}

function analyzeVueFile(file, src, root) {
  const blocks = splitVueSFC(src);
  const scriptBlock = blocks.scripts.find((s) => !s.setup);
  const setupBlock = blocks.scripts.find((s) => s.setup);
  const out = { file, kind: 'vue', imports: [], components: [], hasScriptSetup: !!setupBlock, templateTags: [] };

  if (blocks.template) out.templateTags = scanComponentTags(blocks.template.text);
  const templateCalls = blocks.template ? scanTemplateCalls(blocks.template.text) : [];

  if (scriptBlock) {
    const result = analyzeScript(scriptBlock.text, file);
    if (result.parseError) { out.parseError = result.parseError; return out; }
    out.imports = result.imports;
    out.components = result.components;
    for (const c of out.components) for (const call of templateCalls) c.calls.push(call);
  } else if (setupBlock) {
    // <script setup> = Composition API. Out of scope for deep extraction
    // (see SKILL.md Gotchas) - still parse it far enough to keep the file
    // graph complete (imports matter even for a Composition-API file that
    // a mixed codebase's Options-API components might import).
    const result = analyzeScript(setupBlock.text, file);
    out.imports = result.parseError ? [] : result.imports;
    out.scriptSetupOnly = true;
    if (result.parseError) out.parseError = result.parseError;
  }
  return out;
}

function analyzeHtmlFile(file, src, root) {
  const { scripts } = extractHtmlScripts(src);
  const out = { file, kind: 'html', htmlScripts: [], components: [], imports: [] };
  const bodyOnly = htmlBodyWithoutScripts(src);
  out.templateTags = scanComponentTags(bodyOnly);
  const rootCalls = scanTemplateCalls(bodyOnly);

  let inlineIdx = 0;
  for (const s of scripts) {
    if (s.src) {
      out.htmlScripts.push({ src: s.src, module: s.module, inline: false });
    } else if (s.text && s.text.trim()) {
      inlineIdx++;
      const virtualPath = `${file}#inline-${inlineIdx}`;
      const result = analyzeScript(s.text, virtualPath);
      out.htmlScripts.push({ inline: true, virtualPath, module: s.module, parseError: result.parseError || null });
      if (!result.parseError) {
        out.imports.push(...result.imports.map((i) => ({ ...i, fromInline: virtualPath })));
        out.components.push(...result.components.map((c) => ({ ...c, definedIn: virtualPath })));
      }
    }
  }
  // Root-level markup calls (e.g. @counted="onCounted" on the mount element)
  // belong to whichever inline script defines the root app, if any.
  const rootComp = out.components.find((c) => c.isRoot);
  if (rootComp) for (const call of rootCalls) rootComp.calls.push(call);
  return out;
}

// ----------------------------------------------------------- file graph ---

function analyzeProject(entryFiles, root) {
  const files = {};
  const edges = [];
  const unresolvedEdges = [];
  const externalEdges = [];
  const queue = [...entryFiles];
  const visited = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!fs.existsSync(file)) { files[file] = { file, missing: true }; continue; }

    const data = analyzeFile(file, root);
    files[file] = data;

    if (data.kind === 'html') {
      for (const s of data.htmlScripts) {
        if (s.inline) { edges.push({ from: file, to: s.virtualPath, type: 'inline-script', resolvedInline: true }); continue; }
        if (/^https?:\/\//.test(s.src)) { externalEdges.push({ from: file, type: 'script-src', target: s.src }); continue; }
        const resolved = resolveModulePath(s.src, file, root);
        if (resolved.path) { edges.push({ from: file, to: resolved.path, type: 'script-src' }); if (!visited.has(resolved.path)) queue.push(resolved.path); }
        else if (resolved.external) externalEdges.push({ from: file, type: 'script-src', target: s.src });
        else unresolvedEdges.push({ from: file, type: 'script-src', raw: s.src });
      }
    }

    for (const imp of data.imports || []) {
      if (imp.dynamic && imp.source == null) { unresolvedEdges.push({ from: file, type: 'dynamic-import', raw: imp.raw }); continue; }
      if (imp.source == null) continue;
      const resolved = resolveModulePath(imp.source, file, root);
      if (resolved.path) {
        edges.push({ from: file, to: resolved.path, type: imp.dynamic ? 'dynamic-import' : 'import' });
        if (!visited.has(resolved.path)) queue.push(resolved.path);
      } else if (resolved.external) {
        externalEdges.push({ from: file, type: 'import', target: imp.source });
      } else {
        unresolvedEdges.push({ from: file, type: 'import', raw: imp.source });
      }
    }
  }

  return { files, edges, unresolvedEdges, externalEdges, root };
}

/** For each HTML entry, the set of files it loads (script-src + inline),
 *  and the registry of globally-registered (`Vue.component()`) components
 *  visible on that page. */
function computeHtmlPageRegistries(project, htmlEntries) {
  const registries = new Map(); // htmlFile -> { files: Set, globalComponents: Map(name -> {file, entity}) }
  for (const entry of htmlEntries) {
    const loaded = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
      const f = queue.shift();
      for (const e of project.edges) {
        if (e.from === f && e.to && (e.type === 'script-src' || e.type === 'inline-script') && !loaded.has(e.to)) {
          loaded.add(e.to); queue.push(e.to);
        }
      }
    }
    const globalComponents = new Map();
    for (const f of loaded) {
      const data = project.files[f];
      if (!data || data.missing || data.parseError) continue;
      for (const c of data.components || []) {
        if (c.globalRegistration) globalComponents.set(c.name, { file: f, entity: c });
      }
    }
    registries.set(entry, { loaded, globalComponents });
  }
  return registries;
}

/** "renders" edges: template tag -> the file defining that component,
 *  via local componentsMap+imports (Vite) or the page's global registry
 *  (CDN). Mutates project.edges / project.unresolvedEdges in place. */
function resolveRenderEdges(project, htmlRegistries) {
  for (const [file, data] of Object.entries(project.files)) {
    if (data.missing || data.parseError) continue;
    const owningHtml = [...htmlRegistries.entries()].find(([, reg]) => reg.loaded.has(file))?.[0];
    const globalComponents = owningHtml ? htmlRegistries.get(owningHtml).globalComponents : new Map();

    const tagLists = data.kind === 'html'
      ? [{ tags: data.templateTags, comp: data.components.find((c) => c.isRoot) || null }]
      : (data.components || []).map((c) => ({ tags: scanComponentTags(c.templateOption).concat(data.kind === 'vue' ? data.templateTags : []), comp: c }));

    for (const { tags, comp } of (data.kind === 'vue' ? [{ tags: data.templateTags, comp: data.components[0] || null }] : tagLists)) {
      for (const tag of tags) {
        if (tag.startsWith('__dynamic__:')) {
          project.unresolvedEdges.push({ from: file, type: 'renders', raw: tag.slice('__dynamic__:'.length) });
          continue;
        }
        const pascal = kebabToPascal(tag);
        let resolvedTo = null;
        if (comp?.componentsMap) {
          const bindingName = comp.componentsMap[tag] || comp.componentsMap[pascal];
          if (bindingName) {
            const imp = (data.imports || []).find((i) => i.specifiers?.some((s) => s.local === bindingName));
            if (imp) {
              const resolved = resolveModulePath(imp.source, file, project.root);
              if (resolved.path) resolvedTo = resolved.path;
            }
          }
        }
        if (!resolvedTo && (globalComponents.has(tag) || globalComponents.has(pascal))) {
          resolvedTo = (globalComponents.get(tag) || globalComponents.get(pascal)).file;
        }
        if (resolvedTo) project.edges.push({ from: file, to: resolvedTo, type: 'renders', conditional: false });
        else project.unresolvedEdges.push({ from: file, type: 'renders', raw: tag });
      }
    }
  }
}

// -------------------------------------------------------------- reports ----

function rel(root, p) { return p ? path.relative(root, p) || '.' : p; }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
function setToArr(obj) {
  if (obj instanceof Set) return [...obj];
  if (Array.isArray(obj)) return obj.map(setToArr);
  if (obj && typeof obj === 'object') { const o = {}; for (const k of Object.keys(obj)) o[k] = setToArr(obj[k]); return o; }
  return obj;
}

function buildDependencyGraphMd(project, entries) {
  const { edges, root } = project;
  const label = (f) => (f ? rel(root, f).replace(/"/g, "'") : 'UNRESOLVED');
  const idOf = (f) => `n${Math.abs(hash(f))}`;
  let md = `# Dependency Graph\n\nFile/component graph: ES \`import\`/dynamic \`import()\` (Vite), \`<script src>\`/inline \`<script>\` (CDN HTML), and \`renders\` edges (a template's custom-tag usage resolved to the file defining that component). Paths relative to \`${root}\`.\n\n`;
  md += `## Entry points\n\n${entries.map((e) => `- \`${rel(root, e)}\``).join('\n')}\n\n`;

  md += '## File graph (Mermaid)\n\n```mermaid\nflowchart TD\n';
  const seen = new Set();
  for (const e of edges) {
    const fromId = idOf(e.from);
    if (!seen.has(e.from)) { md += `  ${fromId}["${label(e.from)}"]\n`; seen.add(e.from); }
    const toId = idOf(e.to);
    if (!seen.has(e.to)) { md += `  ${toId}["${label(e.to)}"]\n`; seen.add(e.to); }
    const style = e.type === 'renders' ? '-.->' : '-->';
    md += `  ${fromId} ${style}|"${e.type}"| ${toId}\n`;
  }
  for (const u of project.unresolvedEdges) {
    const fromId = idOf(u.from);
    if (!seen.has(u.from)) { md += `  ${fromId}["${label(u.from)}"]\n`; seen.add(u.from); }
    const toId = idOf('unresolved:' + u.type + ':' + u.raw);
    md += `  ${toId}["⚠️ UNRESOLVED (${u.type}): ${(u.raw || '').replace(/"/g, "'")}"]\n`;
    md += `  ${fromId} -.->|"${u.type} (unresolved)"| ${toId}\n`;
  }
  for (const x of project.externalEdges) {
    const fromId = idOf(x.from);
    if (!seen.has(x.from)) { md += `  ${fromId}["${label(x.from)}"]\n`; seen.add(x.from); }
    const toId = idOf('external:' + x.target);
    if (!seen.has('external:' + x.target)) { md += `  ${toId}["📦 external: ${x.target}"]\n`; seen.add('external:' + x.target); }
    md += `  ${fromId} -->|"${x.type} (external)"| ${toId}\n`;
  }
  md += '```\n\n';

  md += '## Edges (detail)\n\n| From | To | Type |\n|---|---|---|\n';
  for (const e of edges) md += `| \`${rel(root, e.from)}\` | \`${e.to ? rel(root, e.to) : 'UNRESOLVED'}\` | ${e.type} |\n`;

  if (project.externalEdges.length) {
    md += `\n## 📦 External packages / CDN URLs (${project.externalEdges.length})\n\nNot part of this project's own file graph - expected, not a gap.\n\n`;
    md += project.externalEdges.map((x) => `- \`${rel(root, x.from)}\` — ${x.type}: \`${x.target}\``).join('\n') + '\n';
  }

  if (project.unresolvedEdges.length) {
    md += `\n## ⚠️ Unresolved (${project.unresolvedEdges.length})\n\nCould not be statically resolved to a file/component - a computed import path, a dynamic \`<component :is>\`, or a template tag with no matching local/global component definition found.\n\n`;
    md += project.unresolvedEdges.map((u) => `- \`${rel(root, u.from)}\` — ${u.type}: \`${u.raw}\``).join('\n') + '\n';
  }
  return md;
}

function entityFacts(e) {
  const facts = [];
  if (e.calls?.length) facts.push(`Calls: ${[...new Set(e.calls)].map((c) => `\`${c}\``).join(', ')}`);
  if (e.externalReads?.length) facts.push(`Reads external state: ${e.externalReads.map((s) => `\`${s}\``).join(', ')}`);
  if (e.io?.length) facts.push(`External I/O: ${e.io.map((s) => `\`${s.kind}${s.target ? '(' + s.target + ')' : ''}\``).join(', ')}`);
  if (e.outputs?.length) facts.push(`Outputs: ${e.outputs.map((o) => `\`${o.kind}${o.event ? ':' + o.event : ''}\``).join(', ')}`);
  return facts;
}

function componentSummary(root, file, c) {
  let md = `### \`${c.name}\`${c.globalRegistration ? ' _(global, `Vue.component`)_' : ''}${c.isRoot ? ' _(root app instance)_' : ''}\n\n`;
  md += `- **File:** \`${rel(root, file)}\`${c.line ? `:${c.line}` : ''}\n`;
  if (c.props.length) md += `- **Props:** ${c.props.map((p) => `\`${p.name}${p.type ? ': ' + p.type : ''}${p.required ? ' (required)' : ''}\``).join(', ')}\n`;
  if (c.dataFields.length) md += `- **Data fields:** ${c.dataFields.map((f) => `\`${f}\``).join(', ')}\n`;
  if (c.declaredEmits.length) md += `- **Declared emits:** ${c.declaredEmits.map((e) => `\`${e}\``).join(', ')}\n`;
  if (Object.keys(c.componentsMap || {}).length) md += `- **Child components:** ${Object.keys(c.componentsMap).map((k) => `\`${k}\``).join(', ')}\n`;
  if (c.mixins?.length) md += `- **Mixins:** ${c.mixins.map((m) => `\`${m}\``).join(', ')}\n`;
  md += c.doc ? `\n> ${c.doc.formal ? '' : '_(informal comment, not JSDoc)_\n> '}${c.doc.text.split('\n').join('\n> ')}\n\n` : '\n> ⚠️ No doc comment found for this component.\n\n';

  const sections = [
    ['Lifecycle hooks', c.lifecycle], ['Methods', c.methods], ['Computed', c.computed], ['Watchers', c.watchers],
  ];
  for (const [label, list] of sections) {
    if (!list.length) continue;
    md += `**${label}:**\n\n`;
    for (const e of list) {
      const sig = e.params?.length ? `(${e.params.join(', ')})` : '()';
      md += `- \`${e.name}${sig}\`${e.doc ? '' : ' ⚠️ no doc'}`;
      if (e.doc) md += ` — ${e.doc.formal ? '' : '_(informal note)_ '}${e.doc.text.split('\n')[0]}`;
      const facts = entityFacts(e);
      md += facts.length ? ` _(${facts.join('; ')})_` : '';
      md += '\n';
    }
    md += '\n';
  }
  return md;
}

function buildFunctionsReferenceMd(project) {
  const { files, root } = project;
  let md = '# Components & Methods Reference\n\nOne entry per Options-API component definition found while walking the file graph, with its props/data/emits, each method/computed/watcher/lifecycle hook\'s doc comment (or ⚠️ its absence), and facts pulled from static analysis (calls, external reads, I/O, outputs).\n\n';
  let total = 0, documented = 0;

  for (const [file, data] of Object.entries(files)) {
    if (data.missing || data.parseError || !data.components?.length) continue;
    md += `## \`${rel(root, file)}\`\n\n`;
    for (const c of data.components) {
      md += componentSummary(root, file, c);
      total++; if (c.doc?.formal) documented++;
      for (const list of [c.lifecycle, c.methods, c.computed, c.watchers]) {
        for (const e of list) { total++; if (e.doc?.formal) documented++; }
      }
    }
  }
  md += `---\n\n**Coverage:** ${documented}/${total} components/methods/computed/watchers/lifecycle hooks have a formal JSDoc (\`/** */\`) comment in source.\n`;
  return md;
}

function reachableFrom(project, entry, types) {
  const out = [entry];
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    for (const e of project.edges) {
      if (e.from === f && e.to && types.includes(e.type) && !seen.has(e.to)) { seen.add(e.to); out.push(e.to); queue.push(e.to); }
    }
  }
  return out;
}

function buildFunctionRegistry(project) {
  const registry = new Map();
  for (const data of Object.values(project.files)) {
    if (data.missing || data.parseError) continue;
    for (const c of data.components || []) {
      for (const list of [c.methods, c.computed, c.watchers]) {
        for (const e of list) if (!registry.has(e.name)) registry.set(e.name, e);
      }
    }
  }
  return registry;
}

function computeCalledNames(components, registry) {
  const called = new Set();
  const queue = components.flatMap((c) => c.calls || []);
  for (const c of components) for (const e of [...c.lifecycle]) queue.push(...(e.calls || []));
  while (queue.length) {
    const name = queue.shift();
    if (called.has(name)) continue;
    called.add(name);
    const e = registry.get(name);
    if (e) queue.push(...(e.calls || []));
  }
  return called;
}

function buildSpecMd(project, entries) {
  const { files, root } = project;
  const registry = buildFunctionRegistry(project);
  let md = '# Specification (derived from static analysis + comments)\n\n';
  md += 'Assembled mechanically from the AST and doc comments of every file/component reachable from the entry point(s) below (import graph + `<script src>`/inline graph + template `renders` edges). States only what the code and its comments show - gaps are called out explicitly, not filled in.\n\n';

  for (const entry of entries) {
    const reachableFiles = reachableFrom(project, entry, ['import', 'dynamic-import', 'script-src', 'inline-script']);
    const renderReachable = reachableFrom(project, entry, ['import', 'dynamic-import', 'script-src', 'inline-script', 'renders']);

    md += `## Entry point: \`${rel(root, entry)}\`\n\n`;
    md += `### Files loaded by this page\n\n${reachableFiles.map((f) => `- \`${rel(root, f)}\``).join('\n')}\n\n`;
    md += `### Components rendered (including via template usage)\n\n${renderReachable.filter((f) => !reachableFiles.includes(f)).map((f) => `- \`${rel(root, f)}\``).join('\n') || '_None beyond the files already listed above._'}\n\n`;

    const allComponents = [];
    for (const f of renderReachable) {
      const data = files[f];
      if (!data || data.missing || data.parseError) continue;
      for (const c of data.components || []) allComponents.push({ file: f, c });
    }

    const called = computeCalledNames(allComponents.map((x) => x.c), registry);

    const props = [], emits = [], io = [], externalReads = new Set(), docedContracts = [], gaps = [], notCalled = [];
    for (const { file, c } of allComponents) {
      for (const p of c.props) props.push({ file, component: c.name, ...p });
      for (const ev of c.declaredEmits) emits.push({ file, component: c.name, event: ev, declared: true });
      const allEntities = [...c.lifecycle, ...c.methods, ...c.computed, ...c.watchers];
      for (const e of allEntities) {
        for (const r of e.externalReads) externalReads.add(r);
        for (const o of e.outputs) { if (o.kind === 'emit') emits.push({ file, component: c.name, event: o.event, method: e.name, conditional: o.conditional }); }
        for (const i of e.io) io.push({ file, component: c.name, method: e.name, ...i });
        const isReachable = e.entityKind === 'lifecycle' || called.has(e.name);
        if (!isReachable && e.entityKind === 'method') { notCalled.push({ file, component: c.name, name: e.name }); continue; }
        if (e.doc?.formal) docedContracts.push({ file, component: c.name, name: e.name, kind: e.entityKind, doc: e.doc.text });
        else gaps.push({ file, component: c.name, name: e.name, kind: e.entityKind, informalNote: e.doc?.text ?? null });
      }
      if (c.doc?.formal) docedContracts.unshift({ file, component: c.name, name: c.name, kind: 'component', doc: c.doc.text });
      else gaps.push({ file, component: c.name, name: c.name, kind: 'component', informalNote: c.doc?.text ?? null });
    }

    md += `### Props (inputs)\n\n`;
    md += props.length ? props.map((p) => `- \`${rel(root, p.file)}\` — \`${p.component}.${p.name}\`${p.type ? `: ${p.type}` : ''}${p.required ? ' (required)' : ''}${p.default !== undefined ? ` = ${p.default}` : ''}`).join('\n') + '\n\n' : '_None declared._\n\n';

    md += `### External state read (route/store/window/props actually accessed in code)\n\n`;
    md += externalReads.size ? [...externalReads].sort().map((r) => `- \`${r}\``).join('\n') + '\n\n' : '_None detected._\n\n';

    md += `### Emitted events (outputs)\n\n`;
    md += emits.length ? emits.map((e) => `- \`${rel(root, e.file)}\` — \`${e.component}\`: **${e.event}**${e.method ? ` (from \`${e.method}\`)` : ' (declared via `emits`)'}${e.conditional ? ' (conditional)' : ''}`).join('\n') + '\n\n' : '_None detected._\n\n';

    md += `### External I/O (HTTP calls, store dispatch/commit, storage) - reachable from this page only\n\n`;
    md += io.length ? io.map((i) => `- \`${rel(root, i.file)}\` — \`${i.component}.${i.method}\`: **${i.kind}**${i.target ? ` — ${i.target}` : ''}${i.conditional ? ' (conditional)' : ''}`).join('\n') + '\n\n' : '_None detected._\n\n';

    md += `### Documented contracts (from JSDoc comments)\n\n`;
    md += docedContracts.length ? docedContracts.map((c) => `- **${c.kind} \`${c.component}${c.name !== c.component ? '.' + c.name : ''}\`** (\`${rel(root, c.file)}\`):\n\n  > ${c.doc.split('\n').join('\n  > ')}\n`).join('\n') : '_No JSDoc comments found._\n';

    md += `\n### Gaps — no formal JSDoc (${gaps.length})\n\n`;
    md += gaps.length ? gaps.map((g) => `- ${g.kind} \`${g.component}${g.name !== g.component ? '.' + g.name : ''}\` in \`${rel(root, g.file)}\`${g.informalNote ? ` (informal note only: "${g.informalNote.replace(/\n/g, ' ')}")` : ''}`).join('\n') + '\n\n' : '_All documented._\n\n';

    if (notCalled.length) {
      md += `### Defined but not called from this page (${notCalled.length})\n\n`;
      md += 'Present in a component this page loads, but no call was found in the static call graph (script calls + template event bindings) - likely used only by other pages, or dead code.\n\n';
      md += notCalled.map((n) => `- \`${n.component}.${n.name}\` in \`${rel(root, n.file)}\``).join('\n') + '\n\n';
    }

    const unresolvedHere = project.unresolvedEdges.filter((u) => reachableFiles.includes(u.from));
    if (unresolvedHere.length) {
      md += `### ⚠️ Unresolved (reachable from this page)\n\n`;
      md += unresolvedHere.map((u) => `- \`${rel(root, u.from)}\` — ${u.type}: \`${u.raw}\``).join('\n') + '\n\n';
    }
  }
  return md;
}

// ---------------------------------------------------------------- main -----

function commonAncestor(dirs) {
  if (dirs.length === 1) return dirs[0];
  const parts = dirs.map((d) => d.split(path.sep));
  let i = 0;
  while (i < Math.min(...parts.map((p) => p.length)) && parts.every((p) => p[i] === parts[0][i])) i++;
  return parts[0].slice(0, i).join(path.sep) || path.sep;
}

function main() {
  const { entries, out, root } = parseArgs(process.argv.slice(2));
  for (const e of entries) if (!fs.existsSync(e)) { console.error(`Entry file not found: ${e}`); process.exit(1); }
  const effectiveRoot = root || commonAncestor(entries.map((e) => path.dirname(e)));

  const project = analyzeProject(entries, effectiveRoot);
  const htmlEntries = entries.filter((e) => path.extname(e) === '.html' || path.extname(e) === '.htm');
  const htmlRegistries = computeHtmlPageRegistries(project, htmlEntries);
  resolveRenderEdges(project, htmlRegistries);

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(setToArr({ ...project, entries }), null, 2));
  fs.writeFileSync(path.join(out, 'dependency-graph.md'), buildDependencyGraphMd(project, entries));
  fs.writeFileSync(path.join(out, 'functions-reference.md'), buildFunctionsReferenceMd(project));
  fs.writeFileSync(path.join(out, 'SPEC.md'), buildSpecMd(project, entries));

  const fileCount = Object.keys(project.files).length;
  const compCount = Object.values(project.files).reduce((n, f) => n + (f.components?.length || 0), 0);
  console.log(`Analyzed ${fileCount} file(s), ${compCount} component definition(s).`);
  console.log(`Unresolved edges: ${project.unresolvedEdges.length}, external: ${project.externalEdges.length}`);
  console.log(`Output written to: ${out}`);
}

main();
