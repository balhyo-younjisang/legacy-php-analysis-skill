<?php
/**
 * Look up a product's display name by id.
 *
 * @param int $productId Product primary key.
 * @return string Product name, or an empty string if not found.
 */
function get_product_name($productId) {
    $conn = get_db_connection();
    $result = mysqli_query($conn, "SELECT name FROM products WHERE id = " . intval($productId));
    $row = mysqli_fetch_assoc($result);
    return $row ? $row['name'] : '';
}

// NOTE: no docblock on purpose - this is one of the "undocumented" functions
// the extractor should flag as a Spec gap.
function format_price($cents) {
    return number_format($cents / 100, 2);
}

/**
 * Record a page view for basic analytics.
 * Writes directly to the hits table - no return value.
 */
function log_page_view($page) {
    $conn = get_db_connection();
    mysqli_query($conn, "INSERT INTO hits (page, ip) VALUES ('" . $page . "', '" . $_SERVER['REMOTE_ADDR'] . "')");
}
