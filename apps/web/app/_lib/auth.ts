/**
 * Server-side auth helpers.
 *
 * getUser() uses getSession() (local JWT decode, no remote call) because
 * middleware already ran auth.getUser() on the same request and redirected
 * unauthenticated users. Using the session here is safe and saves a remote
 * auth API round-trip on every navigation.
 *
 * getWorkspaceRole() is memoized per-request via React.cache() so layout and
 * any page that both call it only pay once per navigation.
 */
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createUserServerClient, createServiceClient } from './supabase-server';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0, member: 1, admin: 2, owner: 3,
};

// Reads from the cookie — no remote auth call. Safe because middleware
// already called auth.getUser() and redirected if the session was invalid.
export async function getUser(): Promise<User | null> {
  const sb = await createUserServerClient();
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

export async function requireUser(redirectTo?: string): Promise<User> {
  const user = await getUser();
  if (!user) {
    const next = redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : '';
    redirect(`/login${next}`);
  }
  return user;
}

// Cross-request cache: role changes are rare; serve from cache for 5 min.
const _fetchRole = unstable_cache(
  async (userId: string, workspaceId: string): Promise<WorkspaceRole | null> => {
    const sb = createServiceClient();
    const { data } = await sb.from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();
    return (data?.role as WorkspaceRole | undefined) ?? null;
  },
  ['workspace-role'],
  { revalidate: 300 },
);

// Per-request memoization on top: layout + any page calling this in the same
// render pay only once.
export const getWorkspaceRole = cache(
  (userId: string, workspaceId: string): Promise<WorkspaceRole | null> =>
    _fetchRole(userId, workspaceId),
);

export async function requireRole(
  workspaceId: string,
  minRole: WorkspaceRole,
): Promise<{ user: User; role: WorkspaceRole }> {
  const user = await requireUser(`/workspace/${workspaceId}`);
  const role = await getWorkspaceRole(user.id, workspaceId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    redirect('/');
  }
  return { user, role };
}

export function hasRole(role: WorkspaceRole | null, minRole: WorkspaceRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}
