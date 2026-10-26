import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// These synthetic offline contract regressions execute the real handlers with mocked
// API/state dependencies. They do not reproduce production or verify browser layout.
const {test} = process.env.TASK_APPROVAL_OFFLINE
  ? await import('node:test') : await import('@playwright/test');
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
 const {expect}=await import('@playwright/test');
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
  await approve.click();await expect(popup.getByRole('alert')).toContainText('Synthetic approval failure');
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
