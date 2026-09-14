<?php
/**
 * Shopping cart page. A second, independent entry point that shares
 * config.php/functions.php with index.php - used to prove the extractor
 * handles multiple entry points sharing files in one run.
 */

require_once dirname(__FILE__) . '/config.php';
require_once ROOT_PATH . '/inc/functions.php';

session_start();

$total = 0;
foreach ($_SESSION['cart'] ?? [] as $productId => $qty) {
    $total += format_price(1999) * $qty;
}

echo 'Cart total: ' . $total;
