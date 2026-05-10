// Thin OpenAI embedding wrapper. Pinned to text-embedding-3-small (1536 dim) for the whole project.

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;

export async function embed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embed failed (${res.status}): ${body}`);
  }
  const json = await res.json() as { data: { embedding: number[] }[] };
  const vec = json.data[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(`Unexpected embedding shape: ${vec?.length} dims`);
  }
  return vec;
}

// Postgres pgvector wire format: '[0.1,0.2,...]' as text.
export function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
