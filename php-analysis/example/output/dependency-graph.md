# Dependency Graph

Generated from static analysis of `include`/`require`/`include_once`/`require_once` chains, starting at the entry point(s) below. Paths are relative to `/Users/yunjisang/Workspace/krmedics/legacy-php-skills/php-analysis/example/app`.

## Entry points

- `index.php`
- `cart.php`

## File graph (Mermaid)

```mermaid
flowchart TD
  n862004589["index.php"]
  n823729291["config.php"]
  n862004589 -->|"require_once"| n823729291
  n972847765["inc/functions.php"]
  n862004589 -->|"require_once"| n972847765
  n1422589841["inc/User.php"]
  n862004589 -->|"require_once"| n1422589841
  n1855165551["inc/header.php"]
  n862004589 -->|"include"| n1855165551
  n1820227812["inc/admin_panel.php"]
  n862004589 -.->|"include"| n1820227812
  n1213332485["⚠️ UNRESOLVED: $_GET['tab'] . '.php'"]
  n862004589 -.->|"include (dynamic)"| n1213332485
  n1882851231["inc/footer.php"]
  n862004589 -->|"include"| n1882851231
  n142234259["cart.php"]
  n142234259 -->|"require_once"| n823729291
  n142234259 -->|"require_once"| n972847765
```

## Edges (detail)

| From | To | Type | Conditional | In function | Notes |
|---|---|---|---|---|---|
| `index.php`:8 | `config.php` | require_once | no | no |  |
| `index.php`:9 | `inc/functions.php` | require_once | no | no |  |
| `index.php`:10 | `inc/User.php` | require_once | no | no |  |
| `index.php`:12 | `inc/header.php` | include | no | no |  |
| `index.php`:25 | `inc/admin_panel.php` | include | yes | no |  |
| `index.php`:31 | **UNRESOLVED** | include | yes | no | dynamic target: `$_GET['tab'] . '.php'` |
| `index.php`:34 | `inc/footer.php` | include | no | no |  |
| `cart.php`:8 | `config.php` | require_once | no | no |  |
| `cart.php`:9 | `inc/functions.php` | require_once | no | no |  |

## ⚠️ Unresolved / dynamic includes (1)

These could not be resolved to a concrete file by static analysis alone (dynamic path built from a variable, function return value, or unrecognized constant). Read them manually — they may pull in files not otherwise listed in this graph.

- `index.php`:31 — `$_GET['tab'] . '.php'` (conditional)
