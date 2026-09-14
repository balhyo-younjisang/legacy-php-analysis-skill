<?php
/**
 * Admin-only catalog management panel.
 * Only ever included from index.php when User::canManageCatalog() is true.
 */
$conn = get_db_connection();
mysqli_query($conn, "DELETE FROM sessions WHERE expires_at < NOW()");
echo '<section class="admin">Admin panel</section>';
