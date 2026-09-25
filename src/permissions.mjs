export const assignableRoles = [
  ['viewer', 'Consulta'],
  ['manager', 'Gestión'],
];

export function isAssignableRole(role) {
  return assignableRoles.some(([value]) => value === role);
}

export function canManageInventory(role) {
  return role === 'admin' || role === 'manager';
}
