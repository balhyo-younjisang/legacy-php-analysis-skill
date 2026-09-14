<?php
/**
 * Site configuration and DB connection bootstrap.
 * Included by every entry-point page before anything else.
 */

define('ROOT_PATH', dirname(__FILE__));
define('DB_HOST', 'localhost');
define('DB_NAME', 'legacy_shop');

/**
 * Open the (mysqli) database connection used by the rest of the app.
 * @return mysqli
 */
function get_db_connection() {
    static $conn = null;
    if ($conn === null) {
        $conn = mysqli_connect(DB_HOST, 'shop_user', 'secret', DB_NAME);
    }
    return $conn;
}
