import { register } from '../../backend/node_modules/tsx/dist/esm/api/index.mjs';
register();
import assert from 'node:assert/strict';
import { test } from 'node:test';
await import('../../backend/node_modules/openai/shims/web.mjs');
await import('../../backend/node_modules/@anthropic-ai/sdk/shims/web.mjs');
const {generate} = await import('../../backend/providers.ts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=', 'base64');
test('real adapters send image payloads and preserve text calls (mock network)', async () => {
 process.env.OPENAI_API_KEY='synthetic'; process.env.ANTHROPIC_API_KEY='synthetic'; process.env.GOOGLE_API_KEY='synthetic';
 const original=globalThis.fetch; let payload; let response;
 globalThis.fetch=async (_url,init) => {
  payload=JSON.parse(init.body);
  return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});
 };
 try {
  for (const [provider,modelId] of [['openai','gpt-4o'],['openai','gpt-5.4'],['anthropic','claude-test'],['google','gemini-test']]) {
   response=provider==='anthropic'?{model:modelId,content:[{type:'text',text:'source'}],usage:{input_tokens:1,output_tokens:1}}:
    provider==='google'?{candidates:[{content:{parts:[{text:'source'}],role:'model'},finishReason:'STOP'}]}:
    modelId.startsWith('gpt-5.')?{model:modelId,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'source',annotations:[]}]}]}:
    {model:modelId,choices:[{message:{content:'source'}}],usage:{}};
   await generate({provider,modelId,prompt:'extract',images:[{mimeType:'image/png',data:png.toString('base64')}]});
   assert.ok(JSON.stringify(payload).includes(png.toString('base64')),provider);
   await generate({provider,modelId,prompt:'plain text'});
   assert.ok(!JSON.stringify(payload).includes(png.toString('base64')),provider);
  }
  await assert.rejects(generate({provider:'groq',modelId:'text',prompt:'x',images:[{mimeType:'image/png',data:'x'}]}),/không hỗ trợ/);
 } finally { globalThis.fetch=original; }
});
