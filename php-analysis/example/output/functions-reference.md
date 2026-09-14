# Functions & Classes Reference

One entry per function/class/method found while walking the include graph from the entry point(s), combining the code signature with its PHPDoc/inline comment (when present) and facts pulled from static analysis (superglobal reads, SQL, calls, output).

## `config.php`

### `get_db_connection` — `get_db_connection()`

- **File:** `config.php`:15

> Open the (mysqli) database connection used by the rest of the app.
> @return mysqli

- Calls: `mysqli_connect`

## `inc/functions.php`

### `get_product_name` — `get_product_name($productId)`

- **File:** `inc/functions.php`:8

> Look up a product's display name by id.
> 
> @param int $productId Product primary key.
> @return string Product name, or an empty string if not found.

- Calls: `get_db_connection`, `mysqli_query`, `intval`, `mysqli_fetch_assoc`
- Executes SQL: `SELECT name FROM products WHERE id = `

### `format_price` — `format_price($cents)`

- **File:** `inc/functions.php`:17

> _(informal comment, not a PHPDoc block)_
> NOTE: no docblock on purpose - this is one of the "undocumented" functions
> 
> the extractor should flag as a Spec gap.

- Calls: `number_format`

### `log_page_view` — `log_page_view($page)`

- **File:** `inc/functions.php`:25

> Record a page view for basic analytics.
> Writes directly to the hits table - no return value.

- Calls: `get_db_connection`, `mysqli_query`
- Executes SQL: `INSERT INTO hits (page, ip) VALUES ('`

## `inc/User.php`

### `User`

- **File:** `inc/User.php`:5

> Represents the logged-in shop user, backed by $_SESSION.


#### `fromSession` — `fromSession()`

- **File:** `inc/User.php`:16
- **Visibility:** public static

> Load the current user from the session, if any.
> @return User|null


#### `canManageCatalog` — `canManageCatalog()`

- **File:** `inc/User.php`:27
- **Visibility:** public

> _(informal comment, not a PHPDoc block)_
> No docblock - deliberately undocumented for the Spec "gaps" section.


**Properties:** `public $id`, `private $isAdmin = false`

---

**Coverage:** 5/7 functions/classes/methods have a formal `/** */` PHPDoc block in source. The rest (⚠️ marked, including any with only an informal `//` note) were documented purely from static-analysis facts above — verify with the original author before treating those as authoritative.
