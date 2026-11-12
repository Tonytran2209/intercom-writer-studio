import {register} from '../../backend/node_modules/tsx/dist/esm/api/index.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
register();
await import('../../backend/node_modules/openai/shims/web.mjs');
const {evidencePassages, findMarkdownEvidence} = await import('../../backend/markdownEvidence.ts');

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

test('structured evidence keeps each entry whole and cites its heading and URL', async () => {
 const filler = '- filler line that pads the entry so fixed-size chunks would cut it\n'.repeat(40);
 const content = '# Doc\nIntro\n\n## E01 · Hiring\nNguồn: https://www.fab.careers/how-we-hire\n' + filler +
  '- "Show us what you can do through a 30 minute assessment."\n\n## E02 · Values\nNguồn: https://www.fab.careers/f-studio-career-26\n- "We\u2019re honest with ourselves and in what we do."\n';
 const passages = evidencePassages(content);
 assert.deepEqual(passages.map(p => p.heading), ['', 'E01 · Hiring', 'E01 · Hiring', 'E02 · Values']);
 assert.ok(passages.slice(1, 3).every(p => p.url === 'https://www.fab.careers/how-we-hire' && p.text.length <= 2200));
 const originalFetch = globalThis.fetch;
 const originalKey = process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY = 'synthetic';
 // The model returns a straight apostrophe although the document uses a curly one.
 const quote = "We're honest with ourselves and in what we do.";
 globalThis.fetch = async (_url, init) => {
  const prompt = JSON.parse(JSON.parse(init.body).input.at(-1).content);
  assert.ok(prompt.passages.every(p => !/https/.test(p.passage) || p.passage.includes('fab.careers')));
  const index = prompt.passages.find(p => p.passage.includes('honest')).index;
  return Response.json({object:'response',model:'m',output:[{type:'message',role:'assistant',
   content:[{type:'output_text',text:JSON.stringify({index,quote,connection:'F đề cao sự chính trực.'}),annotations:[]}]}]});
 };
 try {
  const result = await findMarkdownEvidence({name:'careers.md',content,uploadedAt:'2026-11-12'},'Chính trực honest',{provider:'openai',modelId:'gpt-5.4-mini'});
  assert.equal(result.reference, 'careers.md · E02 · Values\nNguồn: https://www.fab.careers/f-studio-career-26\n“' + quote + '”');
 } finally {
  globalThis.fetch = originalFetch;
  if(originalKey===undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
 }
});
