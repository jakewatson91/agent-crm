/**
 * Server-side auth helpers. Read the user from the cookie-bound Supabase
 * client; role lookups use the service client to avoid RLS recursion.
 */
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createUserServerClient, createServiceClient } from './supabase-server';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0, member: 1, admin: 2, owner: 3,
};

export async function getUser(): Promise<User | null> {
  const sb = await createUserServerClient();
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}

export async function requireUser(redirectTo?: string): Promise<User> {
  const user = await getUser();
  if (!user) {
    const next = redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : '';
    redirect(`/login${next}`);
  }
  return user;
}

export async function getWorkspaceRole(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const sb = createServiceClient();
  const { data } = await sb.from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.role as WorkspaceRole | undefined) ?? null;
}

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
