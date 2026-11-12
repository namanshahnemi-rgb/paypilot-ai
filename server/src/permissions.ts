// Role-based access control. Code checks permissions, never role names; the
// roles only decide which permissions a user has. Roles are stored in
// user_roles and read on every request, so a role change applies at once.

export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "proposal:create",
  "proposal:read",
  "proposal:update",
  "proposal:review",
  "subscription:read",
  "subscription:manage",
  "admin:users:read",
  "admin:users:update",
  "admin:audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const USER_PERMISSIONS: Permission[] = [
  "proposal:create",
  "proposal:read",
  "proposal:update",
  "proposal:review",
  "subscription:read",
  "subscription:manage",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  user: USER_PERMISSIONS,
  admin: [...USER_PERMISSIONS, "admin:users:read", "admin:users:update", "admin:audit:read"],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// The union of the permissions of every role the user holds. Unknown role
// names (for example from a newer schema) grant nothing.
export function permissionsFor(roles: readonly string[]): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    if (isRole(role)) ROLE_PERMISSIONS[role].forEach((permission) => granted.add(permission));
  }
  return granted;
}
