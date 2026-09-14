# Specification (derived from static analysis + comments)

This spec is assembled mechanically from the AST and doc comments of every file reachable from the entry point(s) below. It states only what the code and its comments actually show — no invented behavior. Anywhere the code's *intent* isn't documented, that is called out explicitly as a gap.

## Entry point: `index.php`

### Included files (in this page)

- `index.php`
- `config.php`
- `inc/functions.php`
- `inc/User.php`
- `inc/header.php`
- `inc/admin_panel.php` _(conditionally included)_
- `inc/footer.php`

### Inputs (superglobals read anywhere in this page's file set)

- `$_GET`
- `$_GET[id]`
- `$_GET[tab]`
- `$_SERVER`
- `$_SERVER[REMOTE_ADDR]`
- `$_SESSION`
- `$_SESSION[is_admin]`
- `$_SESSION[user_id]`

### Outputs / side effects

_Only from code that actually executes on this page: the top-level statements of each included file above, plus functions reachable from them by static call analysis. Class-method calls aren't resolved (no type inference), so a method's own effects are listed if its class's file loads, whether or not the method is ever invoked - flagged in "Documented contracts" below instead of here._

- `index.php` — `index.php`: **session_start** — `session_start();`
- `index.php` — `index.php`: **echo** — `echo '<h1>' . $productName . '</h1>';`
- `index.php` — `index.php`: **echo** — `echo '<p>Price: ' . format_price(1999) . '</p>';`
- `inc/header.php` — `header.php`: **echo** (conditional) — `echo $_SESSION['user_id'];`
- `inc/admin_panel.php` — `admin_panel.php`: **echo** (conditional) — `echo '<section class="admin">Admin panel</section>';`

### Database access (SQL literals found in code)

- `inc/functions.php` — `get_product_name`: `SELECT name FROM products WHERE id = `
- `inc/functions.php` — `log_page_view`: `INSERT INTO hits (page, ip) VALUES ('`
- `inc/admin_panel.php` — `admin_panel.php` (conditional): `DELETE FROM sessions WHERE expires_at < NOW()`

### Documented contracts (from PHPDoc/inline comments)

- **function `get_db_connection`** (`config.php`):

  > Open the (mysqli) database connection used by the rest of the app.
  > @return mysqli

- **function `get_product_name`** (`inc/functions.php`):

  > Look up a product's display name by id.
  > 
  > @param int $productId Product primary key.
  > @return string Product name, or an empty string if not found.

- **function `log_page_view`** (`inc/functions.php`):

  > Record a page view for basic analytics.
  > Writes directly to the hits table - no return value.

- **class `User`** (`inc/User.php`):

  > Represents the logged-in shop user, backed by $_SESSION.

- **method `fromSession`** (`inc/User.php`):

  > Load the current user from the session, if any.
  > @return User|null

### Gaps — functions/classes/methods with NO formal PHPDoc (2)

- function `format_price` in `inc/functions.php` — behavior only inferable from code (has an informal note only: "NOTE: no docblock on purpose - this is one of the "undocumented" functions  the extractor should flag as a Spec gap.").
- method `canManageCatalog` in `inc/User.php` — behavior only inferable from code (has an informal note only: "No docblock - deliberately undocumented for the Spec "gaps" section.").

### ⚠️ Unresolved dynamic includes reachable from this page

Static analysis could not follow these — they may add undocumented inputs/outputs/SQL not reflected above.

- `index.php`:31 — `$_GET['tab'] . '.php'`

## Entry point: `cart.php`

### Included files (in this page)

- `cart.php`
- `config.php`
- `inc/functions.php`

### Inputs (superglobals read anywhere in this page's file set)

- `$_SESSION`
- `$_SESSION[cart]`

### Outputs / side effects

_Only from code that actually executes on this page: the top-level statements of each included file above, plus functions reachable from them by static call analysis. Class-method calls aren't resolved (no type inference), so a method's own effects are listed if its class's file loads, whether or not the method is ever invoked - flagged in "Documented contracts" below instead of here._

- `cart.php` — `cart.php`: **session_start** — `session_start();`
- `cart.php` — `cart.php`: **echo** — `echo 'Cart total: ' . $total;`

### Database access (SQL literals found in code)

_None detected (no recognized SQL call/literal patterns)._

### Documented contracts (from PHPDoc/inline comments)

_No PHPDoc/comments found on any function/class/method in this page._

### Gaps — functions/classes/methods with NO formal PHPDoc (1)

- function `format_price` in `inc/functions.php` — behavior only inferable from code (has an informal note only: "NOTE: no docblock on purpose - this is one of the "undocumented" functions  the extractor should flag as a Spec gap.").

### Defined but not called from this page (3)

Present in a file this page includes, but no call to it was found anywhere in this page's static call graph - likely used only by other pages, or dead code.

- `get_db_connection` in `config.php`
- `get_product_name` in `inc/functions.php`
- `log_page_view` in `inc/functions.php`

