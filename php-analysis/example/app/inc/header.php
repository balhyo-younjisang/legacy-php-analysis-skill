<?php
// Shared page header. Assumes session_start() already happened in index.php.
?>
<!DOCTYPE html>
<html>
<head><title>Legacy Shop</title></head>
<body>
<header>
<?php if (!empty($_SESSION['user_id'])): ?>
    Welcome back, user #<?php echo $_SESSION['user_id']; ?>
<?php else: ?>
    Please log in.
<?php endif; ?>
</header>
