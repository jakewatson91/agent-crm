import { config } from 'dotenv';
config({ path: '.env.local' });
import { chatComplete } from '@agent-crm/primitives';
(async () => {
  try {
    const r = await chatComplete({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'Reply with strict JSON: {"ok": true}' },
        { role: 'user', content: 'test' },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 100,
    });
    console.log('SUCCESS:', r.text);
  } catch (e) {
    console.error('FAILED:', e instanceof Error ? e.stack : e);
  }
})();
