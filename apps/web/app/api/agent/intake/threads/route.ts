/**
 * List chat threads for a workspace. Powers the Recent picker.
 *
 * Returns lean metadata only — id, title (first user message truncated),
 * message_count, updated_at — so the picker can render dozens of threads
 * without pulling every transcript.
 */
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

// Loose shape — transcripts may hold legacy ChatMessage or new UIMessage form
// (AI SDK v6). The list view only needs role + a way to extract a text title,
// so we don't validate fully here.
type StoredMessage = {
  role: string;
  content?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

interface ThreadSummary {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

const TITLE_MAX = 80;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace_id = url.searchParams.get('workspace_id');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 100);
  if (!workspace_id) {
    return new Response(JSON.stringify({ error: 'workspace_id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('conversations')
    .select('id, transcript, updated_at')
    .eq('workspace_id', workspace_id)
    .eq('kind', 'chat')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const threads: ThreadSummary[] = (data ?? [])
    .map((row) => {
      const messages = extractMessages(row.transcript);
      // Skip empty threads (created but no messages yet).
      if (messages.length === 0) return null;
      return {
        id: row.id as string,
        title: titleFor(messages),
        message_count: messages.length,
        updated_at: row.updated_at as string,
      };
    })
    .filter((t): t is ThreadSummary => t !== null);

  return new Response(JSON.stringify({ threads }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractMessages(transcript: unknown): StoredMessage[] {
  if (!transcript || typeof transcript !== 'object') return [];
  const raw = (transcript as { messages?: unknown }).messages;
  return Array.isArray(raw) ? (raw as StoredMessage[]) : [];
}

function titleFor(messages: StoredMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '(empty)';
  // New shape: walk parts for text. Old shape: use content.
  let text = '';
  if (Array.isArray(firstUser.parts)) {
    text = firstUser.parts.filter((p) => p?.type === 'text').map((p) => p.text ?? '').join(' ');
  }
  if (!text && typeof firstUser.content === 'string') text = firstUser.content;
  text = text.trim().replace(/\s+/g, ' ');
  if (!text) return '(empty)';
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
}
