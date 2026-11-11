import {register} from '../../backend/node_modules/tsx/dist/esm/api/index.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
register();
await import('../../backend/node_modules/openai/shims/web.mjs');
const {findMarkdownEvidence} = await import('../../backend/markdownEvidence.ts');

test('Markdown evidence references only quotes present in the uploaded document', async () => {
 const originalFetch = globalThis.fetch;
 const originalKey = process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY = 'synthetic';
 const quote = 'F.Learning Studio hosted a workshop on peer feedback.';
 const document = {name:'workshops.md',content:'# Workshops\n' + quote,uploadedAt:'2026-11-11'};
 const model = {provider:'openai',modelId:'gpt-5.4-mini'};
 let result = {index:0,quote,connection:'F tổ chức workshop về phản hồi đồng nghiệp.'};
 globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.text.format.type,'json_object');
  assert.match(body.input.find(message=>message.role==='system').content,/\bJSON\b/i);
  const prompt = JSON.parse(body.input.at(-1).content);
  assert.equal(prompt.document,document.name);
  assert.ok(prompt.passages[0].passage.includes(quote));
  return Response.json({object:'response',model:model.modelId,output:[{type:'message',role:'assistant',
   content:[{type:'output_text',text:JSON.stringify(result),annotations:[]}]}]});
 };
 try {
  assert.deepEqual(await findMarkdownEvidence(document,'Peer feedback',model),{
   connection:result.connection,reference:'workshops.md\n“' + quote + '”',
  });
  result = {...result,quote:'F.Learning Studio hosted a conference that is absent from the document.'};
  assert.equal(await findMarkdownEvidence(document,'Peer feedback',model),null);
  result = {...result,index:null,quote};
  assert.equal(await findMarkdownEvidence(document,'Peer feedback',model),null);
 } finally {
  globalThis.fetch = originalFetch;
  if(originalKey===undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
 }
});
