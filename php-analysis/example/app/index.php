<?php
/**
 * Product detail page. Entry point for /index.php?id=123
 */

session_start();

require_once dirname(__FILE__) . '/config.php';
require_once ROOT_PATH . '/inc/functions.php';
require_once ROOT_PATH . '/inc/User.php';

include ROOT_PATH . '/inc/header.php';

log_page_view('index');

$user = User::fromSession();

$productId = isset($_GET['id']) ? $_GET['id'] : 0;
$productName = get_product_name($productId);

echo '<h1>' . $productName . '</h1>';
echo '<p>Price: ' . format_price(1999) . '</p>';

if ($user && $user->canManageCatalog()) {
    include ROOT_PATH . '/inc/admin_panel.php';
}

// Legacy tab router - target file name comes straight from the query
// string, so static analysis cannot know which file this pulls in.
if (isset($_GET['tab'])) {
    include $_GET['tab'] . '.php';
}

include ROOT_PATH . '/inc/footer.php';
