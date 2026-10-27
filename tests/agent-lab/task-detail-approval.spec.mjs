import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// These synthetic offline contract regressions execute the real handlers with mocked
// API/state dependencies. They do not reproduce production or verify browser layout.
const {test} = process.env.TASK_APPROVAL_OFFLINE
  ? await import('node:test') : await import('./browser-fixture.mjs');
const source = readFileSync(new URL('../../src/components/EbWorkingSpace.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('workspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
 let result;
 function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(parsed) === name) result = node;
  ts.forEachChild(node, visit);
 }
 visit(parsed);
 assert.ok(result, `Missing real implementation: ${name}`);
 return ts.isVariableDeclaration(result) ? `const ${result.getText(parsed)};` : result.getText(parsed);
}
function harness({gate='brief', models=true, status='ready', type, shell=false}={}) {
 const task={id:'pkg-contract',gate,status,type,title:'Synthetic contract'};
 const state={tasks:[task],pending:false,error:null,runtime:null,syncing:false,calls:[]};
 const config={models:models ? [
  {id:'gate-two',provider:'mock-g2',enabled:true},
  {id:'adapt',provider:'mock-adapt',enabled:true},
  {id:'editor',provider:'mock-editor',enabled:true},
 ]:[],stepConfigs:{2:{modelId:'gate-two'},4:{modelId:'editor'}},ebRuntimeSettings:{adaptModelId:'adapt'}};
 const lock={current:false};
 const db={
  approveEbV2Brief:async(...args)=>{state.calls.push(['brief',...args]);},
  approveEbV2Article:async(...args)=>{state.calls.push(['article',...args]);return {};},
  fetchEbV2Workspace:async()=>{state.calls.push(['workspace']);return {};},
 };
 const js=ts.transpileModule([declaration('selectedModel'),declaration('canApproveTask'),declaration('approveTask'),'return approveTask;'].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const names=['tasks','syncing','config','approvalLock','isShellMode','db','workspaceTasks','setTasks','setApprovalError','setApprovalPending','setSyncing','setRuntimeError'];
 const approve=new Function(...names,js)(state.tasks,false,config,lock,shell,db,data=>data.tasks??[],
  update=>{state.tasks=typeof update==='function'?update(state.tasks):update;},
  value=>{state.error=value;},value=>{state.pending=value;},value=>{state.syncing=value;},value=>{state.runtime=value;});
 return {state,task,db,approve,lock};
}
for (const gate of ['brief','article']) {
 test(`${gate}: correct model, package ID, shared lock, and workspace synchronization`,async()=>{
  const h=harness({gate});let release;
  const original=gate==='brief'?h.db.approveEbV2Brief:h.db.approveEbV2Article;
  h.db[gate==='brief'?'approveEbV2Brief':'approveEbV2Article']=async(...args)=>{
   await original(...args);return await new Promise(resolve=>{release=()=>resolve({tasks:[{...h.task,gate:'adapt'}]});});
  };
  const request=h.approve(h.task,gate);
  await Promise.resolve();
  assert.equal(h.state.pending,true);
  await h.approve(h.task,gate); // card and popup invoke the same protected handler
  assert.deepEqual(h.state.calls[0],[gate,'pkg-contract',gate==='brief'?{provider:'mock-g2',id:'gate-two'}:{provider:'mock-adapt',id:'adapt'}]);
  assert.equal(h.state.calls.length,1);
  release();await request;
  assert.equal(h.state.pending,false);assert.equal(h.lock.current,false);assert.equal(h.state.error,null);
  assert.ok(!h.state.tasks.some(t=>t.gate===gate));
 });
 test(`${gate}: failure unlocks retry; missing models never call API`,async()=>{
  const h=harness({gate});const key=gate==='brief'?'approveEbV2Brief':'approveEbV2Article';
  h.db[key]=async()=>{throw new Error('Synthetic API failure');};
  await h.approve(h.task,gate);
  assert.match(h.state.error.message,/Synthetic API failure/);assert.equal(h.state.pending,false);
  h.db[key]=async()=>({});await h.approve(h.task,gate);assert.equal(h.state.error,null);
  const missing=harness({gate,models:false});await missing.approve(missing.task,gate);
  assert.deepEqual(missing.state.calls,[]);assert.match(missing.state.error.message,/Choose/);
 });
}
test('running, approved, Adapt and Review tasks cannot invoke gate approvals',async()=>{
 for(const options of [{gate:'brief',status:'checking'},{gate:'article',status:'drafting'},{gate:'article',type:'Approved website article'},{gate:'adapt'},{gate:'review'}]) {
  const h=harness(options);await h.approve(h.task,options.gate);assert.deepEqual(h.state.calls,[]);
 }
});
test('persisted brief approval cannot be repeated after a failed workspace read',async()=>{
 const h=harness();h.db.fetchEbV2Workspace=async()=>{throw new Error('Synthetic read failure');};
 await h.approve(h.task,'brief');assert.equal(h.state.tasks[0].gate,'article');assert.equal(h.state.tasks[0].status,'drafting');
 assert.match(h.state.error.message,/Synthetic read failure/);
});

if (!process.env.TASK_APPROVAL_OFFLINE) {
 const {expect}=await import('./browser-fixture.mjs');
 for(const gate of ['brief','article'])test(`${gate} popup approval shows errors, locks card and popup, and advances`,async({page})=>{
  let data={packages:[{id:'popup',title:'Synthetic popup',state:gate}],articles:gate==='article'?[{package_id:'popup',status:'draft',revision:1}]:[],channels:[],runs:[],discovery:[]};
  const calls=[];const unexpected=[];let fail=true;let release;
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin==='https://fonts.googleapis.com')return route.fulfill({body:'',contentType:'text/css'});
   if(url.origin==='http://127.0.0.1:4173') {
    if(req.method()==='GET'&&url.pathname==='/api/eb-v2/workspace')return route.fulfill({json:data});
    if(req.method()==='GET'&&url.pathname.startsWith('/api/eb-v2/activity/'))return route.fulfill({json:{inputs:[],runs:[],articles:[],channels:[],feedback:[],actions:[]}});
    if(req.method()==='POST'&&url.pathname===`/api/eb-v2/packages/popup/approve-${gate}`){
     calls.push(req.postDataJSON());
     if(fail)return route.fulfill({status:500,json:{error:'Synthetic approval failure'}});
     await new Promise(resolve=>{release=resolve;});
     data={...data,packages:[{...data.packages[0],state:gate==='brief'?'article':'adapt'}],articles:[],channels:gate==='article'?[{id:'output',package_id:'popup',channel:'linkedin',status:'queued'}]:[]};
     return route.fulfill({json:data});
    }
    if(req.method()==='GET'&&!url.pathname.startsWith('/api/'))return route.continue();
   }
   unexpected.push(`${req.method()} ${url.origin}${url.pathname}`);return route.abort();
  });
  await page.goto('/?screen=eb');
  await page.evaluate(async()=>{
   const {DEFAULT_CONFIG,DEFAULT_MODELS}=await import('/src/lib/defaultData.ts');
   DEFAULT_CONFIG.models=[{...DEFAULT_MODELS[0],id:'popup-model',enabled:true}];
  });
  await page.getByRole('button',{name:'Open task: Synthetic popup',exact:true}).click();
  const popup=page.locator('aside');const approve=popup.getByRole('button',{name:`Approve ${gate}`,exact:true});
  await approve.click();await expect(popup.getByRole('alert').filter({hasText:'Synthetic approval failure'})).toContainText('Synthetic approval failure');
  await expect(approve).toBeEnabled();fail=false;await approve.click();
  await expect.poll(()=>calls.length).toBe(2);await expect(approve).toBeDisabled();
  const cardApprove=page.getByRole('button',{name:`Approve ${gate}`,exact:true}).first();
  await expect(cardApprove).toBeDisabled();await cardApprove.evaluate(button=>button.click());
  expect(calls).toHaveLength(2);expect(calls[1][gate==='brief'?'model':'adaptModel'].id).toBe('popup-model');
  await expect(popup.getByRole('status')).toContainText('Saving approval');release();
  await expect(page.getByRole('button',{name:`Approve ${gate}`,exact:true})).toHaveCount(0);
  expect(unexpected).toEqual([]);
 });
}

// Synthetic persistence/AI boundaries around the actual regenerate route.
const backendSource = readFileSync(new URL('../../backend/ebV2.ts', import.meta.url), 'utf8');
const backendAst = ts.createSourceFile('ebV2.ts', backendSource, ts.ScriptTarget.Latest, true);
function backendRoute(path) {
 let callback;
 function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(backendAst) === 'app.post' && node.arguments[0]?.text === path) callback=node.arguments[1].getText(backendAst);
  ts.forEachChild(node,visit);
 }
 visit(backendAst);assert.ok(callback);
 return ts.transpileModule(`return (${callback});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
}
function regenerationHarness() {
 const state={writes:[],inputs:[{id:'old',input_text:'Original topic',raw_snapshot:{sourceType:'upload',briefValidation:{connection:'old connection',evidence:'old evidence'}}}],runs:[],locks:new Set(),validationError:false,saveError:false,aiError:false};
 class BriefInputError extends Error {}
 const deps={
  randomUUID:()=> 'synthetic-unique-id', text:value=>String(value??'').trim(), modelFrom:()=>({provider:'mock',modelId:'gate-one'}),
  one:async()=>({id:'pkg',title:'Topic'}),briefRegenerationLocks:state.locks,BriefInputError,
  tableSelect:async(table)=>table==='eb_v2_package_inputs'?state.inputs:state.runs,
  requireBriefInput:(_input,connection,evidence)=>{if(!connection||!evidence||connection==='N/A')throw new BriefInputError('missing fields');},
  preflightBrief:async(_input,fields)=>{if(state.validationError)throw new BriefInputError('validation failed');return {connection:fields.fConnection,evidence:fields.fEvidence,validatedAt:'new-validation'};},
  tableInsert:async(table,row)=>{if(state.saveError)throw new Error('save failed');state.writes.push([table,row]);state.inputs.unshift({...row,id:'new'});return row;},
  archiveOutputs:async()=>state.writes.push(['archiveOutputs']),archiveArticles:async()=>state.writes.push(['archiveArticles']),
  tableUpdate:async(...args)=>state.writes.push(args),stages:{brief:'brief'},libraryContext:async()=>[],
  runGate:async(...args)=>{state.generation=args;if(state.pause)await state.pause;if(state.aiError)throw new Error('AI failed');state.runs=[{status:'completed',output_snapshot:{content:'Fresh brief'},rule_snapshot:args[6]}];},
  workspace:async()=>({packages:[]}),hasUnresolvedValue:value=>!value,
 };
 const make=path=>new Function(...Object.keys(deps),backendRoute(path))(...Object.values(deps));
 const invoke=async(body={},path='regenerate')=>{const res={code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}};await make(`/api/eb-v2/packages/:id/${path}`)({params:{id:'pkg'},body:{stage:'brief',model:{id:'gate-one'},...body}},res);return res;};
 return {state,invoke};
}
test('regenerate validates before writes, preserves source metadata, and supplies saved evidence to the real run call',async()=>{
 const h=regenerationHarness();
 for(const body of [{fConnection:'N/A',fEvidence:'source'},{fConnection:'',fEvidence:''}]){assert.equal((await h.invoke(body)).code,422);assert.equal(h.state.writes.length,0);}
 h.state.validationError=true;assert.equal((await h.invoke()).code,422);assert.equal(h.state.writes.length,0);
 h.state.validationError=false;
 assert.equal((await h.invoke({fConnection:'Specific F event',fEvidence:'https://example.test/reference'})).code,200);
 assert.equal(h.state.inputs[0].input_text,'Original topic');assert.equal(h.state.inputs[0].raw_snapshot.sourceType,'upload');
 assert.match(h.state.generation[3],/Specific F event/);assert.match(h.state.generation[3],/https:\/\/example.test\/reference/);
 assert.equal(h.state.generation[4].modelId,'gate-one');assert.equal(h.state.generation[6].briefRegenerationAt,'new-validation:synthetic-unique-id');
});
test('regenerate blocks concurrent calls and approval, keeps failed snapshots safe, and permits retry',async()=>{
 const h=regenerationHarness();let release;h.state.pause=new Promise(resolve=>{release=resolve;});
 const pending=h.invoke();while(!h.state.generation)await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await h.invoke()).code,409);
 assert.match((await h.invoke({},'approve-brief')).data.error,/Gate 1/);
 release();await pending;assert.equal(h.state.locks.size,0);
 h.state.pause=null;h.state.aiError=true;assert.equal((await h.invoke()).code,500);
 h.state.runs=[{status:'completed',output_snapshot:{content:'Old brief'},rule_snapshot:{}}];
 assert.match((await h.invoke({},'approve-brief')).data.error,/Brief/);
 h.state.aiError=false;assert.equal((await h.invoke()).code,200);
 h.state.saveError=true;assert.equal((await h.invoke()).code,500);assert.equal(h.state.locks.size,0);
 h.state.saveError=false;assert.equal((await h.invoke()).code,200);
});

if (!process.env.TASK_APPROVAL_OFFLINE) {
 const {expect}=await import('./browser-fixture.mjs');
 test('existing brief detail saves connection and evidence, retains failed edits, and reloads saved values',async({page})=>{
  const data={packages:[{id:'existing',title:'Existing brief',state:'brief'}],articles:[],channels:[],runs:[],discovery:[]};
  let saved={connection:'Saved F connection',evidence:'Saved source'};let fail=true;const calls=[];
  await page.route('**/api/eb-v2/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path.endsWith('/workspace'))return route.fulfill({json:data});
   if(path.includes('/activity/'))return route.fulfill({json:{inputs:[{id:'input',input_text:'Synthetic original topic',raw_snapshot:{briefValidation:saved}}],runs:[],articles:[],channels:[],feedback:[],actions:[]}});
   if(path.endsWith('/regenerate')){
    const body=req.postDataJSON();calls.push(body);
    if(fail)return route.fulfill({status:422,json:{error:'Synthetic validation failure'}});
    saved={connection:body.fConnection,evidence:body.fEvidence};return route.fulfill({json:data});
   }
   return route.abort();
  });
  await page.goto('/?screen=eb');
  await page.evaluate(async()=>{const {DEFAULT_CONFIG,DEFAULT_MODELS}=await import('/src/lib/defaultData.ts');DEFAULT_CONFIG.models=[{...DEFAULT_MODELS[0],id:'brief-editor',enabled:true}];});
  await page.getByRole('button',{name:'Open task: Existing brief',exact:true}).click();
  const popup=page.locator('aside');const connection=popup.getByLabel('Mối liên hệ với F');const evidence=popup.getByLabel('Dẫn chứng / nguồn xác nhận tại F');
  await expect(connection).toHaveValue(saved.connection);await expect(evidence).toHaveValue(saved.evidence);
  await connection.fill('Specific synthetic F event');await evidence.fill('https://example.test/evidence');
  await popup.getByRole('button',{name:'Lưu và chạy lại brief',exact:true}).click();
  await expect(popup.getByRole('alert').filter({hasText:'Synthetic validation failure'})).toContainText('Synthetic validation failure');
  await expect(connection).toHaveValue('Specific synthetic F event');fail=false;
  await popup.getByRole('button',{name:'Lưu và chạy lại brief',exact:true}).click();
  await expect.poll(()=>calls.length).toBe(2);await expect(popup.getByRole('alert').filter({hasText:'Synthetic validation failure'})).toHaveCount(0);
  expect(calls[1]).toMatchObject({stage:'brief',model:{id:'brief-editor'},fConnection:'Specific synthetic F event',fEvidence:'https://example.test/evidence'});
  await page.keyboard.press('Escape');
  // Close via the existing header control when Escape is not a task-detail shortcut.
  if(await connection.isVisible())await popup.locator('header button').last().click();
  await page.getByRole('button',{name:'Open task: Existing brief',exact:true}).click();
  await expect(connection).toHaveValue(saved.connection);await expect(evidence).toHaveValue(saved.evidence);
 });
}
