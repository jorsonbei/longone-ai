export type AppRole = 'user' | 'editor' | 'admin';

const ADMIN_EMAILS = new Set([
  'jorsonbei@gmail.com',
]);

const EDITOR_EMAILS = new Set<string>([]);

export function resolveAppRole(email: string | null | undefined): AppRole {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return 'user';
  if (ADMIN_EMAILS.has(normalized)) return 'admin';
  if (EDITOR_EMAILS.has(normalized)) return 'editor';
  return 'user';
}

