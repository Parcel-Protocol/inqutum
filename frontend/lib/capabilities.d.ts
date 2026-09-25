import type { Permission, Role } from '../../shared/access-control';

export function roleForSession(session?: { connected?: boolean; publicKey?: string | null } | null): Role;
export function canDo(
  role: Role | string,
  permission: Permission,
  resource?: { wallet?: string | null; sellerPublicKey?: string | null }
): boolean;
