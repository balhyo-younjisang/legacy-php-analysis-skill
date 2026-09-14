<?php
/**
 * Represents the logged-in shop user, backed by $_SESSION.
 */
class User {
    /** @var int|null */
    public $id;

    /** @var bool */
    private $isAdmin = false;

    /**
     * Load the current user from the session, if any.
     * @return User|null
     */
    public static function fromSession() {
        if (!isset($_SESSION['user_id'])) {
            return null;
        }
        $u = new User();
        $u->id = $_SESSION['user_id'];
        $u->isAdmin = !empty($_SESSION['is_admin']);
        return $u;
    }

    // No docblock - deliberately undocumented for the Spec "gaps" section.
    public function canManageCatalog() {
        return $this->isAdmin;
    }
}
