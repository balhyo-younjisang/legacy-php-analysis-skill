#!/usr/bin/env node
/**
 * php-analysis extractor
 * -----------------------
 * Static-analysis driver for legacy PHP (<=8) code bases.
 *
 * Given one or more entry-point .php files, it:
 *  1. Follows include/require/include_once/require_once chains recursively
 *     (best-effort static path resolution: literals, __DIR__/__FILE__/dirname(),
 *     string concatenation, and define()'d constants). Anything it cannot
 *     resolve statically is reported as a "dynamic include" rather than
 *     silently dropped.
 *  2. Parses every reachable file with a real PHP AST parser (php-parser,
 *     vendored in scripts/node_modules) and extracts functions, classes,
 *     methods, PHPDoc/inline doc comments, superglobal usage ($_GET etc.),
 *     SQL string literals, and echo/header/exit-style outputs.
 *  3. Emits structured facts (facts.json) plus three human-readable Markdown
 *     reports: dependency-graph.md, functions-reference.md, SPEC.md.
 *
 * This script only extracts and organizes FACTS. Writing documentation from
 * a user-requested "perspective" (security review, data-flow walkthrough,
 * business-rule summary, etc.) is a reasoning task for the calling agent,
 * done by reading facts.json + the generated .md files and never inventing
 * behavior that isn't backed by them. See SKILL.md.
 *
 * Usage:
 *   node extract.mjs <entry.php> [<entry2.php> ...] [--out DIR] [--root DIR]
 *
 *   --out DIR   output directory (default: ./php-analysis-out)
 *   --root DIR  project root used to resolve legacy "docroot-absolute"
 *               includes like include('/inc/db.php') meaning
 *               <root>/inc/db.php rather than a real filesystem root.
 *               Defaults to the common parent directory of the entry files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from 'php-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI -----

function parseArgs(argv) {
  const entries = [];
  let out = 'php-analysis-out';
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out = argv[++i]; }
    else if (a === '--root') { root = argv[++i]; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('-')) { entries.push(a); }
    else { console.error(`Unknown flag: ${a}`); process.exit(1); }
  }
  if (entries.length === 0) { printHelp(); process.exit(1); }
  return { entries: entries.map((e) => path.resolve(e)), out: path.resolve(out), root: root ? path.resolve(root) : null };
}

function printHelp() {
  console.log(`Usage: node extract.mjs <entry.php> [<entry2.php> ...] [--out DIR] [--root DIR]`);
}

// ------------------------------------------------------------- helpers ----

const SUPERGLOBALS = new Set(['_GET', '_POST', '_REQUEST', '_SESSION', '_COOKIE', '_SERVER', '_FILES', '_ENV', 'GLOBALS']);
const OUTPUT_FUNCS = new Set(['header', 'exit', 'die', 'setcookie', 'session_start', 'session_destroy', 'session_regenerate_id']);
const SQL_FUNCS = new Set(['mysqli_query', 'mysql_query', 'mysqli_prepare', 'pg_query', 'pg_query_params', 'sqlite_query']);
const SQL_RE = /^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;

const parser = new Engine({
  parser: { extractDoc: true, php7: true, suppressErrors: true },
  ast: { withPositions: true },
  // Legacy PHP commonly uses the short open tag (`<?` instead of `<?php`).
  // Without this, php-parser silently treats the whole file as one opaque
  // "inline" HTML node - no functions/includes/anything recognized, and no
  // parse error either. short_tags:true makes `<?`/`<?=` parse as PHP.
  lexer: { short_tags: true },
});

function slice(src, node, max = 160) {
  if (!node || !node.loc) return null;
  const s = src.slice(node.loc.start.offset, node.loc.end.offset).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Returns { text, formal } where `formal` is true only for a real PHPDoc
// block (starts with slash-star-star). A plain "//" or slash-star note is
// still surfaced (legacy code leans on those too) but never counted as a
// documented contract, so the Spec's "gaps" section isn't fooled by an
// unrelated one-line comment.
function docText(node) {
  const comments = node && node.leadingComments;
  if (!comments || comments.length === 0) return null;
  const formal = comments.some((c) => c.kind === 'commentblock' && c.value.startsWith('/**'));
  const text = comments
    .map((c) => c.value.replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\/\/\s?/, '')
      .split('\n').map((l) => l.replace(/^\s*\*\s?/, '').replace(/^\s*\/\/\s?/, '').trimEnd()).join('\n').trim())
    .filter(Boolean)
    .join('\n\n') || null;
  return text ? { text, formal } : null;
}

function typeToString(t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (t.kind === 'name') return t.name;
  if (t.kind === 'nullable' && t.what) return '?' + typeToString(t.what);
  if (t.kind === 'uniontype' && t.types) return t.types.map(typeToString).join('|');
  if (t.name) return typeof t.name === 'string' ? t.name : typeToString(t.name);
  return '<type>';
}

function literalToString(node) {
  if (!node) return null;
  switch (node.kind) {
    case 'string': return JSON.stringify(node.value);
    case 'number': return String(node.value);
    case 'boolean': return node.value ? 'true' : 'false';
    case 'nullkeyword': return 'null';
    case 'array': return '[]';
    default: return null;
  }
}

function paramSig(p) {
  const type = typeToString(p.type);
  const name = '$' + (p.name.name ?? p.name);
  const def = p.value ? ' = ' + (literalToString(p.value) ?? '…') : '';
  return (type ? type + ' ' : '') + (p.byref ? '&' : '') + (p.variadic ? '...' : '') + name + def;
}

function makeEntity(node, kind, src, extra = {}) {
  return {
    entityKind: kind, // 'function' | 'method' | 'class'
    name: node.name?.name ?? node.name ?? '(anonymous)',
    line: node.loc?.start?.line ?? null,
    doc: docText(node),
    params: node.arguments ? node.arguments.map(paramSig) : undefined,
    returnType: typeToString(node.type) || undefined,
    calls: [],
    superglobals: new Set(),
    sql: [],
    outputs: [],
    includesSeen: [],
    ...extra,
  };
}

// ------------------------------------------------------ constant pre-scan --

/** Best-effort collection of define()/const literals across a set of files,
 *  used to resolve includes like `include ROOT_PATH . '/inc/db.php';`. */
function scanConstants(files, sources) {
  const constants = new Map();
  // Legacy code commonly defines path constants as `define('ROOT_PATH',
  // dirname(__FILE__))` or references one constant from another
  // (`define('INC_PATH', ROOT_PATH . '/inc')`), so a single top-to-bottom
  // pass isn't enough - re-scan a few times so later constants can resolve
  // via earlier ones, using the same resolveTarget() evaluator as includes.
  for (let pass = 0; pass < 3; pass++) {
    for (const file of files) {
      const src = sources.get(file);
      if (!src) continue;
      let ast;
      try { ast = parser.parseCode(src, file); } catch { continue; }
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (node.kind === 'call' && node.what?.kind === 'name' && node.what.name === 'define') {
          const [nameArg, valArg] = node.arguments || [];
          if (nameArg?.kind === 'string') {
            const resolved = resolveTarget(valArg, file, constants);
            if (!resolved.dynamic) constants.set(nameArg.value, resolved.text);
          }
        } else if (node.kind === 'constantstatement' && node.constants) {
          for (const c of node.constants) {
            const resolved = resolveTarget(c.value, file, constants);
            if (!resolved.dynamic) constants.set(c.name?.name ?? c.name, resolved.text);
          }
        }
        if (!node.kind) { for (const k of Object.keys(node)) visit(node[k]); return; }
        for (const k of Object.keys(node)) { if (k !== 'loc') visit(node[k]); }
      };
      visit(ast);
    }
  }
  return constants;
}

// -------------------------------------------------- include target resolve --

function resolveTarget(node, currentFile, constants) {
  if (!node) return { dynamic: true };
  switch (node.kind) {
    case 'string':
      return { text: node.value, dynamic: false };
    case 'magic':
      if (node.value === '__DIR__') return { text: path.dirname(currentFile), dynamic: false };
      if (node.value === '__FILE__') return { text: currentFile, dynamic: false };
      return { dynamic: true };
    case 'bin':
      if (node.type === '.') {
        const l = resolveTarget(node.left, currentFile, constants);
        const r = resolveTarget(node.right, currentFile, constants);
        if (!l.dynamic && !r.dynamic) return { text: l.text + r.text, dynamic: false };
      }
      return { dynamic: true };
    case 'call':
      if (node.what?.kind === 'name' && node.what.name === 'dirname' && node.arguments?.[0]) {
        const arg = resolveTarget(node.arguments[0], currentFile, constants);
        if (!arg.dynamic) return { text: path.dirname(arg.text), dynamic: false };
      }
      return { dynamic: true };
    case 'name':
      if (constants.has(node.name)) return { text: constants.get(node.name), dynamic: false };
      return { dynamic: true };
    case 'constref':
      if (node.name && constants.has(node.name.name ?? node.name)) {
        return { text: constants.get(node.name.name ?? node.name), dynamic: false };
      }
      return { dynamic: true };
    default:
      return { dynamic: true };
  }
}

function toFsPath(text, currentFile, root) {
  const candidates = [];
  if (path.isAbsolute(text)) {
    candidates.push(text);
    if (root) candidates.push(path.join(root, text.replace(/^[/\\]+/, '')));
  } else {
    candidates.push(path.resolve(path.dirname(currentFile), text));
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    if (fs.existsSync(c + '.php') && fs.statSync(c + '.php').isFile()) return c + '.php';
  }
  return null;
}

// -------------------------------------------------------------- walking ----

const CONDITIONAL_KINDS = new Set(['if', 'while', 'dowhile', 'for', 'foreach', 'switch', 'try', 'ternary']);

function analyzeFile(file, src, constants, root) {
  let ast;
  const errors = [];
  try {
    ast = parser.parseCode(src, file);
  } catch (e) {
    return { file, parseError: String(e.message || e), functions: [], classes: [], topLevel: makeEntity({ loc: null, name: '(page)' }, 'page', src), includes: [], uses: [], namespace: null };
  }
  if (ast.errors && ast.errors.length) {
    for (const e of ast.errors) errors.push(`${e.message} (line ${e.line})`);
  }

  const page = { entityKind: 'page', name: path.basename(file), calls: [], superglobals: new Set(), sql: [], outputs: [], includesSeen: [] };
  const functions = [];
  const classes = [];
  const includes = [];
  const uses = [];
  let namespace = null;

  function recordCallLike(node, ctx) {
    const entity = ctx.entity;
    let calleeName = null;
    if (node.what?.kind === 'name') calleeName = node.what.name;
    else if (node.what?.kind === 'propertylookup' || node.what?.kind === 'staticlookup' || node.what?.kind === 'nullsafepropertylookup') {
      calleeName = slice(src, node.what, 60);
    }
    if (calleeName) entity.calls.push(calleeName);

    if (calleeName && SQL_FUNCS.has(calleeName)) {
      for (const arg of node.arguments || []) {
        if (arg.kind === 'string' && SQL_RE.test(arg.value)) {
          entity.sql.push({ line: arg.loc?.start?.line ?? null, text: arg.value, conditional: ctx.conditional });
        }
      }
    }
    if (calleeName && (calleeName === 'query' || calleeName === 'exec' || calleeName === 'prepare')) {
      // $pdo->query("SELECT ..."), $stmt->execute(...): capture if any string arg looks like SQL
      for (const arg of node.arguments || []) {
        if (arg.kind === 'string' && SQL_RE.test(arg.value)) {
          entity.sql.push({ line: arg.loc?.start?.line ?? null, text: arg.value, conditional: ctx.conditional, via: slice(src, node.what, 60) });
        }
      }
    }
    if (calleeName && OUTPUT_FUNCS.has(calleeName)) {
      entity.outputs.push({ kind: calleeName, line: node.loc?.start?.line ?? null, text: slice(src, node, 120), conditional: ctx.conditional });
    }
  }

  function recordInclude(node, ctx) {
    const type = (node.require ? 'require' : 'include') + (node.once ? '_once' : '');
    const resolved = resolveTarget(node.target, file, constants);
    let toFile = null;
    if (!resolved.dynamic) toFile = toFsPath(resolved.text, file, root);
    const entry = {
      fromFile: file,
      type,
      line: node.loc?.start?.line ?? null,
      inFunction: ctx.entity.entityKind !== 'page',
      conditional: ctx.conditional,
      dynamic: resolved.dynamic,
      literalTarget: resolved.dynamic ? null : resolved.text,
      toFile,
      raw: slice(src, node.target, 160) ?? slice(src, node, 160),
    };
    includes.push(entry);
    ctx.entity.includesSeen.push(entry);
  }

  function walk(node, ctx) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, ctx); return; }
    if (!node.kind) { for (const k of Object.keys(node)) { if (k !== 'loc') walk(node[k], ctx); } return; }

    let nextCtx = ctx;

    switch (node.kind) {
      case 'namespace':
        namespace = typeof node.name === 'string' ? node.name : node.name?.name ?? namespace;
        break;
      case 'usegroup':
        for (const item of node.items || []) uses.push(item.name?.name ?? item.name);
        break;
      case 'function': {
        const fn = makeEntity(node, 'function', src);
        functions.push(fn);
        nextCtx = { ...ctx, entity: fn };
        break;
      }
      case 'class':
      case 'interface':
      case 'trait': {
        const cls = makeEntity(node, 'class', src, {
          extends: node.extends ? (Array.isArray(node.extends) ? node.extends.map((n) => n.name) : node.extends.name) : null,
          implements: (node.implements || []).map((n) => n.name),
          methods: [],
          properties: [],
        });
        classes.push(cls);
        nextCtx = { ...ctx, entity: cls, currentClass: cls };
        break;
      }
      case 'method': {
        const owner = ctx.currentClass;
        const m = makeEntity(node, 'method', src, {
          visibility: node.visibility || 'public',
          isStatic: !!node.isStatic,
          isAbstract: !!node.isAbstract,
        });
        if (owner) owner.methods.push(m);
        nextCtx = { ...ctx, entity: m };
        break;
      }
      case 'propertystatement': {
        const owner = ctx.currentClass;
        if (owner) {
          for (const p of node.properties || []) {
            owner.properties.push({
              name: p.name?.name ?? p.name,
              visibility: node.visibility || 'public',
              default: p.value ? (literalToString(p.value) ?? '…') : undefined,
              doc: docText(node) || docText(p),
            });
          }
        }
        break;
      }
      case 'call':
        recordCallLike(node, ctx);
        break;
      case 'include':
        recordInclude(node, ctx);
        break;
      case 'variable':
        if (SUPERGLOBALS.has(node.name)) ctx.entity.superglobals.add(node.name === 'GLOBALS' ? 'GLOBALS' : node.name);
        break;
      case 'offsetlookup':
        if (node.what?.kind === 'variable' && SUPERGLOBALS.has(node.what.name)) {
          const key = node.offset?.kind === 'string' ? node.offset.value : '*';
          ctx.entity.superglobals.add(`${node.what.name}[${key}]`);
        }
        break;
      case 'echo':
      case 'print':
        ctx.entity.outputs.push({ kind: node.kind, line: node.loc?.start?.line ?? null, text: slice(src, node, 120), conditional: ctx.conditional });
        break;
      case 'string':
        if (SQL_RE.test(node.value)) {
          ctx.entity.sql.push({ line: node.loc?.start?.line ?? null, text: node.value, conditional: ctx.conditional });
        }
        break;
      default:
        break;
    }

    if (CONDITIONAL_KINDS.has(node.kind)) {
      nextCtx = { ...nextCtx, conditional: true };
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments') continue;
      walk(node[k], nextCtx);
    }
  }

  walk(ast, { entity: page, conditional: false, currentClass: null });

  // A SQL literal passed straight to mysqli_query()/->query() etc. is seen
  // twice by the walk above: once via the generic "any string that looks
  // like SQL" check, once via the call-argument check (which additionally
  // captures which method invoked it). Collapse those to one entry per line.
  for (const entity of [page, ...functions, ...classes, ...classes.flatMap((c) => c.methods)]) {
    const byLine = new Map();
    for (const s of entity.sql) {
      const existing = byLine.get(s.line);
      if (!existing || (!existing.via && s.via)) byLine.set(s.line, s);
    }
    entity.sql = [...byLine.values()];
  }

  return {
    file,
    parseErrors: errors,
    namespace,
    uses,
    functions,
    classes,
    includes,
    topLevel: page,
  };
}

function setToArr(obj) {
  if (obj instanceof Set) return [...obj];
  if (Array.isArray(obj)) return obj.map(setToArr);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = setToArr(obj[k]);
    return out;
  }
  return obj;
}

// ------------------------------------------------------------- traversal ---

function analyzeProject(entryFiles, root) {
  // Pass 1: pre-scan for constants across every .php file under root (or,
  // if no root given, under each entry's directory), so include-path
  // resolution can substitute define()'d path constants.
  const prescanRoot = root || commonAncestor(entryFiles.map((f) => path.dirname(f)));
  const allPhpFiles = walkDir(prescanRoot).filter((f) => f.endsWith('.php'));
  const sources = new Map();
  for (const f of allPhpFiles) {
    try { sources.set(f, fs.readFileSync(f, 'utf8')); } catch { /* unreadable, skip */ }
  }
  const constants = scanConstants(allPhpFiles, sources);

  // Pass 2: BFS the real include graph starting from the entry files only -
  // this is "all files that actually compose this page", not every file in
  // the directory tree.
  const files = {};
  const edges = [];
  const unresolved = [];
  const queue = [...entryFiles];
  const visited = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    let src = sources.get(file);
    if (src === undefined) {
      try { src = fs.readFileSync(file, 'utf8'); sources.set(file, src); }
      catch { files[file] = { file, missing: true }; continue; }
    }

    const result = analyzeFile(file, src, constants, root || prescanRoot);
    files[file] = result;

    for (const inc of result.includes) {
      edges.push({ from: file, to: inc.toFile, type: inc.type, conditional: inc.conditional, inFunction: inc.inFunction, dynamic: inc.dynamic, literalTarget: inc.literalTarget, raw: inc.raw, line: inc.line });
      if (inc.dynamic || !inc.toFile) {
        unresolved.push({ ...inc });
      } else if (!visited.has(inc.toFile)) {
        queue.push(inc.toFile);
      }
    }
  }

  return { files, edges, unresolved, constants: Object.fromEntries(constants), root: root || prescanRoot };
}

function commonAncestor(dirs) {
  if (dirs.length === 1) return dirs[0];
  const parts = dirs.map((d) => d.split(path.sep));
  let i = 0;
  while (parts.every((p) => p[i] === parts[0][i]) && i < Math.min(...parts.map((p) => p.length))) i++;
  return parts[0].slice(0, i).join(path.sep) || path.sep;
}

function walkDir(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, out);
    else out.push(full);
  }
  return out;
}

// -------------------------------------------------------------- reports ----

function rel(root, p) { return p ? path.relative(root, p) || '.' : p; }

function buildDependencyGraphMd(project, entries) {
  const { edges, root } = project;
  let md = `# Dependency Graph\n\nGenerated from static analysis of \`include\`/\`require\`/\`include_once\`/\`require_once\` chains, starting at the entry point(s) below. Paths are relative to \`${root}\`.\n\n`;

  md += `## Entry points\n\n${entries.map((e) => `- \`${rel(root, e)}\``).join('\n')}\n\n`;

  md += `## File graph (Mermaid)\n\n\`\`\`mermaid\nflowchart TD\n`;
  const idOf = (f) => `n${Math.abs(hash(f))}`;
  const seenNodes = new Set();
  // Mermaid's flowchart syntax uses [ ] { } ( ) to delimit node shape even
  // inside a quoted label, so a raw PHP snippet like `$_SERVER['DOCUMENT_ROOT']`
  // dropped straight into a label breaks the whole diagram's parse, not just
  // that one node. HTML-entity-escape the bracket characters (Mermaid renders
  // these back to literal brackets) instead of passing them through raw.
  const mermaidSafe = (s) => s.replace(/"/g, "'").replace(/\[/g, '#91;').replace(/\]/g, '#93;').replace(/\{/g, '#123;').replace(/\}/g, '#125;');
  const label = (f) => f ? mermaidSafe(rel(root, f)) : 'UNRESOLVED';
  for (const e of edges) {
    const fromId = idOf(e.from);
    if (!seenNodes.has(e.from)) { md += `  ${fromId}["${label(e.from)}"]\n`; seenNodes.add(e.from); }
    if (e.to) {
      const toId = idOf(e.to);
      if (!seenNodes.has(e.to)) { md += `  ${toId}["${label(e.to)}"]\n`; seenNodes.add(e.to); }
      const style = e.conditional ? '-.->' : '-->';
      md += `  ${fromId} ${style}|"${e.type}${e.inFunction ? ' (in fn)' : ''}"| ${toId}\n`;
    } else {
      const toId = idOf('unresolved:' + e.raw);
      md += `  ${toId}["⚠️ UNRESOLVED: ${mermaidSafe(e.literalTarget || e.raw || '')}"]\n`;
      md += `  ${fromId} -.->|"${e.type} (dynamic)"| ${toId}\n`;
    }
  }
  md += '```\n\n';

  md += `## Edges (detail)\n\n| From | To | Type | Conditional | In function | Notes |\n|---|---|---|---|---|---|\n`;
  for (const e of edges) {
    const to = e.to ? `\`${rel(root, e.to)}\`` : '**UNRESOLVED**';
    const notes = e.dynamic || !e.to ? `dynamic target: \`${e.raw}\`` : '';
    md += `| \`${rel(root, e.from)}\`:${e.line ?? ''} | ${to} | ${e.type} | ${e.conditional ? 'yes' : 'no'} | ${e.inFunction ? 'yes' : 'no'} | ${notes} |\n`;
  }

  if (project.unresolved.length) {
    md += `\n## ⚠️ Unresolved / dynamic includes (${project.unresolved.length})\n\n`;
    md += `These could not be resolved to a concrete file by static analysis alone (dynamic path built from a variable, function return value, or unrecognized constant). Read them manually — they may pull in files not otherwise listed in this graph.\n\n`;
    for (const u of project.unresolved) {
      md += `- \`${rel(root, u.fromFile)}\`:${u.line ?? '?'} — \`${u.raw}\`${u.conditional ? ' (conditional)' : ''}${u.inFunction ? ' (inside a function)' : ''}\n`;
    }
  }
  return md;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function entitySummary(root, file, e) {
  const kind = e.entityKind;
  const sig = kind === 'class' ? null : `${e.name}(${(e.params || []).join(', ')})${e.returnType ? ': ' + e.returnType : ''}`;
  let md = `### \`${e.name}\`${sig ? ` — \`${sig}\`` : ''}\n\n`;
  md += `- **File:** \`${rel(root, file)}\`${e.line ? `:${e.line}` : ''}\n`;
  if (kind === 'class') {
    if (e.extends) md += `- **Extends:** \`${e.extends}\`\n`;
    if (e.implements?.length) md += `- **Implements:** \`${e.implements.join(', ')}\`\n`;
  }
  if (kind === 'method') {
    md += `- **Visibility:** ${e.visibility}${e.isStatic ? ' static' : ''}${e.isAbstract ? ' abstract' : ''}\n`;
  }
  if (e.doc) {
    const label = e.doc.formal ? '' : '_(informal comment, not a PHPDoc block)_\n> ';
    md += `\n> ${label}${e.doc.text.split('\n').join('\n> ')}\n\n`;
  } else {
    md += `\n> ⚠️ No PHPDoc/comment found for this ${kind}.\n\n`;
  }

  const facts = [];
  if (e.calls?.length) facts.push(`Calls: ${[...new Set(e.calls)].map((c) => `\`${c}\``).join(', ')}`);
  if (e.superglobals?.length) facts.push(`Reads superglobals: ${e.superglobals.map((s) => `\`$${s}\``).join(', ')}`);
  if (e.sql?.length) facts.push(`Executes SQL: ${e.sql.map((s) => '`' + s.text.replace(/`/g, "'") + '`').join(', ')}`);
  if (e.outputs?.length) facts.push(`Produces output/side-effects: ${e.outputs.map((o) => `\`${o.kind}\``).join(', ')}`);
  if (e.includesSeen?.length) facts.push(`Includes other files from inside: ${e.includesSeen.map((i) => i.toFile ? `\`${rel(root, i.toFile)}\`` : `dynamic (\`${i.raw}\`)`).join(', ')}`);
  if (facts.length) md += facts.map((f) => `- ${f}`).join('\n') + '\n';
  return md + '\n';
}

function buildFunctionsReferenceMd(project) {
  const { files, root } = project;
  let md = `# Functions & Classes Reference\n\nOne entry per function/class/method found while walking the include graph from the entry point(s), combining the code signature with its PHPDoc/inline comment (when present) and facts pulled from static analysis (superglobal reads, SQL, calls, output).\n\n`;
  let total = 0, documented = 0;

  for (const [file, data] of Object.entries(files)) {
    if (data.missing || data.parseError) continue;
    if (!data.functions.length && !data.classes.length) continue;
    md += `## \`${rel(root, file)}\`\n\n`;
    for (const fn of data.functions) {
      total++; if (fn.doc?.formal) documented++;
      md += entitySummary(root, file, fn);
    }
    for (const cls of data.classes) {
      total++; if (cls.doc?.formal) documented++;
      md += entitySummary(root, file, cls);
      for (const m of cls.methods) {
        total++; if (m.doc?.formal) documented++;
        md += entitySummary(root, file, m).replace('### `', '#### `');
      }
      if (cls.properties.length) {
        md += `**Properties:** ${cls.properties.map((p) => `\`${p.visibility} $${p.name}${p.default !== undefined ? ' = ' + p.default : ''}\``).join(', ')}\n\n`;
      }
    }
  }

  md += `---\n\n**Coverage:** ${documented}/${total} functions/classes/methods have a formal \`/** */\` PHPDoc block in source. The rest (⚠️ marked, including any with only an informal \`//\` note) were documented purely from static-analysis facts above — verify with the original author before treating those as authoritative.\n`;
  return md;
}

function buildSpecMd(project, entries) {
  const { files, root } = project;
  let md = `# Specification (derived from static analysis + comments)\n\n`;
  md += `This spec is assembled mechanically from the AST and doc comments of every file reachable from the entry point(s) below. It states only what the code and its comments actually show — no invented behavior. Anywhere the code's *intent* isn't documented, that is called out explicitly as a gap.\n\n`;

  const registry = buildFunctionRegistry(project); // name -> [{file, entity}] across the whole project

  for (const entry of entries) {
    const reachable = reachableFrom(project, entry);
    const conditionalFile = computeFileConditionality(project, entry, reachable);
    const calledFns = computeCalledFunctions(project, reachable, registry);

    md += `## Entry point: \`${rel(root, entry)}\`\n\n`;
    md += `### Included files (in this page)\n\n${reachable.map((f) => `- \`${rel(root, f)}\`${conditionalFile.get(f) ? ' _(conditionally included)_' : ''}`).join('\n')}\n\n`;

    const inputs = new Set(), outputs = [], sql = [], docedContracts = [], undocFns = [], notCalled = [];
    for (const f of reachable) {
      const data = files[f];
      if (!data || data.missing || data.parseError) continue;
      const fileCond = conditionalFile.get(f) || false;
      // Only the file's own top-level code, and functions actually reached
      // by the page's call graph, describe what running this page DOES.
      // Class methods aren't call-graph-tracked (that needs type inference
      // this tool doesn't attempt), so they're conservatively always
      // included whenever their file is reachable - see the note below.
      const executedEntities = [data.topLevel, ...data.functions.filter((fn) => calledFns.has(fn.name))];
      const methodEntities = data.classes.flatMap((c) => c.methods);
      for (const e of [...executedEntities, ...data.classes, ...methodEntities]) {
        for (const s of e.superglobals || []) inputs.add(s);
        if (executedEntities.includes(e)) {
          for (const o of e.outputs || []) outputs.push({ file: f, entity: e.name, ...o, conditional: o.conditional || fileCond });
          for (const s of e.sql || []) sql.push({ file: f, entity: e.name, ...s, conditional: s.conditional || fileCond });
        }
        if (e.entityKind !== 'page') {
          if (e.doc?.formal) docedContracts.push({ file: f, name: e.name, entityKind: e.entityKind, doc: e.doc.text });
          else undocFns.push({ file: f, name: e.name, entityKind: e.entityKind, informalNote: e.doc?.text ?? null });
        }
      }
      for (const fn of data.functions) {
        if (!calledFns.has(fn.name)) notCalled.push({ file: f, name: fn.name });
      }
    }

    md += `### Inputs (superglobals read anywhere in this page's file set)\n\n`;
    md += inputs.size ? [...inputs].sort().map((i) => `- \`$${i}\``).join('\n') + '\n\n' : '_None detected._\n\n';

    md += `### Outputs / side effects\n\n_Only from code that actually executes on this page: the top-level statements of each included file above, plus functions reachable from them by static call analysis. Class-method calls aren't resolved (no type inference), so a method's own effects are listed if its class's file loads, whether or not the method is ever invoked - flagged in "Documented contracts" below instead of here._\n\n`;
    md += outputs.length
      ? outputs.map((o) => `- \`${rel(root, o.file)}\` — \`${o.entity}\`: **${o.kind}**${o.conditional ? ' (conditional)' : ''} — \`${o.text}\``).join('\n') + '\n\n'
      : '_None detected (no echo/print/header/exit/session/cookie calls found)._\n\n';

    md += `### Database access (SQL literals found in code)\n\n`;
    md += sql.length
      ? sql.map((s) => `- \`${rel(root, s.file)}\` — \`${s.entity}\`${s.conditional ? ' (conditional)' : ''}: \`${s.text.replace(/`/g, "'")}\``).join('\n') + '\n\n'
      : '_None detected (no recognized SQL call/literal patterns)._\n\n';

    md += `### Documented contracts (from PHPDoc/inline comments)\n\n`;
    md += docedContracts.length
      ? docedContracts.map((c) => `- **${c.entityKind} \`${c.name}\`** (\`${rel(root, c.file)}\`):\n\n  > ${c.doc.split('\n').join('\n  > ')}\n`).join('\n')
      : '_No PHPDoc/comments found on any function/class/method in this page._\n';

    md += `\n### Gaps — functions/classes/methods with NO formal PHPDoc (${undocFns.length})\n\n`;
    md += undocFns.length
      ? undocFns.map((u) => `- ${u.entityKind} \`${u.name}\` in \`${rel(root, u.file)}\` — behavior only inferable from code${u.informalNote ? ` (has an informal note only: "${u.informalNote.replace(/\n/g, ' ')}")` : ', not confirmed by any comment'}.`).join('\n') + '\n\n'
      : '_All functions/classes/methods in this page have a formal PHPDoc block in source._\n\n';

    if (notCalled.length) {
      md += `### Defined but not called from this page (${notCalled.length})\n\n`;
      md += `Present in a file this page includes, but no call to it was found anywhere in this page's static call graph - likely used only by other pages, or dead code.\n\n`;
      md += notCalled.map((n) => `- \`${n.name}\` in \`${rel(root, n.file)}\``).join('\n') + '\n\n';
    }

    const unresolvedForEntry = project.unresolved.filter((u) => reachable.includes(u.fromFile));
    if (unresolvedForEntry.length) {
      md += `### ⚠️ Unresolved dynamic includes reachable from this page\n\n`;
      md += `Static analysis could not follow these — they may add undocumented inputs/outputs/SQL not reflected above.\n\n`;
      md += unresolvedForEntry.map((u) => `- \`${rel(root, u.fromFile)}\`:${u.line ?? '?'} — \`${u.raw}\``).join('\n') + '\n\n';
    }
  }

  return md;
}

function reachableFrom(project, entry) {
  const out = [entry];
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    for (const e of project.edges) {
      if (e.from === f && e.to && !seen.has(e.to)) { seen.add(e.to); out.push(e.to); queue.push(e.to); }
    }
  }
  return out;
}

/** name -> entity, across every file the project touched (used to walk the
 *  plain-function call graph; collisions - two files defining the same
 *  function name, which real PHP would fatal on anyway - just keep the
 *  first one seen). */
function buildFunctionRegistry(project) {
  const registry = new Map();
  for (const data of Object.values(project.files)) {
    if (data.missing || data.parseError) continue;
    for (const fn of data.functions || []) {
      if (!registry.has(fn.name)) registry.set(fn.name, fn);
    }
  }
  return registry;
}

/** file -> bool: whether EVERY known path from `entry` to that file passes
 *  through at least one conditional include. A file reachable via any
 *  unconditional path is "always" included, even if some other path to it
 *  is conditional. */
function computeFileConditionality(project, entry, reachableFiles) {
  const cond = new Map(reachableFiles.map((f) => [f, undefined]));
  cond.set(entry, false);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of project.edges) {
      if (!e.to || cond.get(e.from) === undefined) continue;
      const via = cond.get(e.from) || e.conditional;
      const prev = cond.get(e.to);
      const next = prev === undefined ? via : (prev && via);
      if (next !== prev) { cond.set(e.to, next); changed = true; }
    }
  }
  return cond;
}

/** Best-effort forward call graph over plain function calls only (no type
 *  inference, so `$obj->method()` / `Class::method()` aren't followed -
 *  see the note printed alongside "Outputs / side effects" in SPEC.md). */
function computeCalledFunctions(project, reachableFiles, registry) {
  const called = new Set();
  const queue = [];
  for (const f of reachableFiles) {
    const data = project.files[f];
    if (!data || data.missing || data.parseError) continue;
    queue.push(...(data.topLevel.calls || []));
  }
  while (queue.length) {
    const name = queue.shift();
    if (called.has(name)) continue;
    called.add(name);
    const fn = registry.get(name);
    if (fn) queue.push(...(fn.calls || []));
  }
  return called;
}

// ---------------------------------------------------------------- main -----

function main() {
  const { entries, out, root } = parseArgs(process.argv.slice(2));
  for (const e of entries) {
    if (!fs.existsSync(e)) { console.error(`Entry file not found: ${e}`); process.exit(1); }
  }

  const project = analyzeProject(entries, root);
  fs.mkdirSync(out, { recursive: true });

  fs.writeFileSync(path.join(out, 'facts.json'), JSON.stringify(setToArr({ ...project, entries }), null, 2));
  fs.writeFileSync(path.join(out, 'dependency-graph.md'), buildDependencyGraphMd(project, entries));
  fs.writeFileSync(path.join(out, 'functions-reference.md'), buildFunctionsReferenceMd(project));
  fs.writeFileSync(path.join(out, 'SPEC.md'), buildSpecMd(project, entries));

  const fileCount = Object.keys(project.files).length;
  const fnCount = Object.values(project.files).reduce((n, f) => n + (f.functions?.length || 0) + (f.classes?.reduce((m, c) => m + 1 + c.methods.length, 0) || 0), 0);
  console.log(`Analyzed ${fileCount} file(s), ${fnCount} function/class/method entities.`);
  console.log(`Unresolved/dynamic includes: ${project.unresolved.length}`);
  console.log(`Output written to: ${out}`);
}

main();
