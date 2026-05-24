/**
 * Single chat thread: load by id, delete by id.
 *
 * Thread *listing* lives at ../threads/route.ts. The chat default is empty,
 * so this endpoint is only hit when the user explicitly clicks a thread in
 * the Recent picker.
 */
import { createServerClient } from '@agent-crm/db';

export const runtime = 'nodejs';

// Transcripts may hold legacy ChatMessage or new UIMessage form. The client
// decides how to interpret. Legacy threads simply won't rehydrate into the
// new useChat surface — fine for dogfood.
interface ThreadResponse {
  conversation_id: string;
  messages: unknown[];
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const workspace_id = url.searchParams.get('workspace_id');
  if (!id || !workspace_id) {
    return new Response(JSON.stringify({ error: 'id and workspace_id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('conversations')
    .select('id, transcript')
    .eq('id', id)
    .eq('workspace_id', workspace_id)
    .eq('kind', 'chat')
    .maybeSingle();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!data) {
    return new Response(JSON.stringify({ error: 'thread not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }

  const body: ThreadResponse = {
    conversation_id: data.id as string,
    messages: extractMessages(data.transcript),
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const workspace_id = url.searchParams.get('workspace_id');
  if (!id || !workspace_id) {
    return new Response(JSON.stringify({ error: 'id and workspace_id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServerClient();
  const { error, count } = await supabase
    .from('conversations')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspace_id)
    .eq('kind', 'chat');

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ deleted: count ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function extractMessages(transcript: unknown): unknown[] {
  if (!transcript || typeof transcript !== 'object') return [];
  const raw = (transcript as { messages?: unknown }).messages;
  return Array.isArray(raw) ? raw : [];
}
