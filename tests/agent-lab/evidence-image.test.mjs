import { register } from '../../backend/node_modules/tsx/dist/esm/api/index.mjs';
register();
import assert from 'node:assert/strict';
import { test } from 'node:test';
await import('../../backend/node_modules/openai/shims/web.mjs');
await import('../../backend/node_modules/@anthropic-ai/sdk/shims/web.mjs');
const { Readable } = await import('node:stream');
const {generate} = await import('../../backend/providers.ts');
const {registerEbV2Routes, evidenceImageMime} = await import('../../backend/ebV2.ts');
const {default: express} = await import('../../backend/node_modules/express/index.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=', 'base64');
test('image signatures reject text disguised as an image', () => {
 assert.equal(evidenceImageMime(png),'image/png');
 assert.equal(evidenceImageMime(Buffer.from('not an image')),null);
 assert.equal(evidenceImageMime(Buffer.from([255,216,255,224])),'image/jpeg');
 assert.equal(evidenceImageMime(Buffer.from('RIFFxxxxWEBP')),'image/webp');
});
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
test('scan endpoint validates uploads, reports failures and never accesses persistence', async () => {
 let handler;
 const app=new Proxy({}, {get: (_target,method) => (path,...handlers) => { if(method==='post' && path==='/api/eb-v2/evidence/scan') handler=handlers[0]; }});
 registerEbV2Routes(app);
 const original=globalThis.fetch; let output='Synthetic visible source'; let providerCalls=0;
 globalThis.fetch=async (url,init) => {
  if (String(url).startsWith('http://127.0.0.1')) return original(url,init);
  providerCalls++;
  return new Response(JSON.stringify({model:'gpt-4o',choices:[{message:{content:output}}],usage:{}}),{headers:{'content-type':'application/json'}});
 };
 async function scan(bytes=png,model={provider:'openai',id:'gpt-4o'}) {
  const body=new FormData();body.append('file',new Blob([bytes],{type:'image/png'}),'fixture.png');body.append('model',JSON.stringify(model));
  const request=new Request('http://offline.test',{method:'POST',body});
  const bytesBody=Buffer.from(await request.arrayBuffer());
  const req=Readable.from([bytesBody]);
  req.headers={'content-type':request.headers.get('content-type'),'content-length':String(bytesBody.length)};
  req.body={};
  return new Promise(resolve=>{
   const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});return this;}};
   handler(req,res);
  });
 }
 try {
  assert.equal((await scan(Buffer.from('bad'))).status,415);
  assert.equal((await scan(Buffer.alloc(15*1024*1024+1))).status,400);
  assert.equal((await scan(png,{provider:'groq',id:'text'})).body.code,'UNSUPPORTED_MODEL');
  assert.equal(providerCalls,0);
  assert.deepEqual((await scan()).body,{evidence:output});
  output='';assert.equal((await scan()).body.code,'UNREADABLE_IMAGE');
  output='x'.repeat(16001);assert.equal((await scan()).body.code,'RESULT_TOO_LONG');
  globalThis.fetch=async(url,init)=>String(url).startsWith('http://127.0.0.1')?original(url,init):Promise.reject(new Error('mock unsupported image model'));
  assert.equal((await scan()).body.code,'SCAN_FAILED');
 } finally { globalThis.fetch=original; }
});
