import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const key = process.env.OPENROUTER_API_KEY!;
  const model = 'openai/gpt-oss-120b:free';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'pong' }], max_tokens: 5 }),
  });
  console.log(`${model} → status ${r.status}`);
  console.log((await r.text()).slice(0, 240));
}
main();
