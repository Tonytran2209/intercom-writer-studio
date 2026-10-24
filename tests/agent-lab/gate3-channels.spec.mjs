import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// Synthetic contract fixtures, not evidence of a production reproduction.
const platforms = ['threads', 'facebook', 'linkedin'];
const label = channel => ({threads:'Threads',facebook:'Facebook',linkedin:'LinkedIn'}[channel]);
const text = (pkg, channel) => `${pkg}_${channel}_SENTINEL\n\nSaved verbatim — Threads, Facebook and LinkedIn are valid references.\n`;
function workspace() {
 return {packages:['one','two'].map(id=>({id,title:`PACKAGE_${id}`,state:'review',source_type:'input'})),
  articles:[],runs:[],discovery:[],channels:['one','two'].flatMap(pkg=>platforms.map(channel=>({
   id:`${pkg}-${channel}`,package_id:pkg,channel,status:'ready_for_review',content:{text:text(pkg,channel)},
  })))};
}
async function setup(page) {
 const state={data:workspace(),mutations:[],unexpected:[],errors:[]};
 page.on('pageerror',error=>state.errors.push(error.message));
 await page.addInitScript(()=>{
  window.__copied=[];
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.__copied.push(value)}});
 });
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin==='https://fonts.googleapis.com'&&url.pathname==='/css2')return route.fulfill({contentType:'text/css',body:''});
  if(url.origin==='http://127.0.0.1:4173') {
   if(req.method()==='GET'&&url.pathname==='/api/eb-v2/workspace')return route.fulfill({json:state.data});
   if(req.method()==='GET'&&url.pathname.startsWith('/api/eb-v2/activity/')) {
    const pkg=url.pathname.split('/').pop();
    return route.fulfill({json:{channels:state.data.channels.filter(row=>row.package_id===pkg),
     selectedChannel:{id:`${pkg}-linkedin`},inputs:[],articles:[],actions:[],feedback:[],
     runs:[{gate:'adapt',status:'completed',output_snapshot:{content:'RUN_DISTRACTOR'}}]}});
   }
   if(req.method()==='POST'&&/^\/api\/eb-v2\/channel-outputs\/[^/]+\/(review|regenerate)$/.test(url.pathname)) {
    state.mutations.push({path:url.pathname,body:req.postDataJSON()});
    return route.fulfill({json:state.data});
   }
   if(req.method()==='GET'&&!url.pathname.startsWith('/api/'))return route.continue();
  }
  state.unexpected.push(`${req.method()} ${url.origin}${url.pathname}`);
  return route.abort();
 });
 await page.goto('/?screen=eb');
 return state;
}
const panel = page => page.locator('aside').filter({has:page.getByRole('heading',{name:'Channel output',exact:true})});
const result = page => panel(page).locator('section').filter({has:page.getByRole('heading',{name:'Channel output',exact:true})});
const row = (page,channel) => panel(page).locator('article').filter({has:page.getByRole('button',{name:`More actions for ${label(channel)}`,exact:true})});
async function open(page,pkg='one') {
 await page.getByRole('button',{name:`Open task: PACKAGE_${pkg}`,exact:true}).click();
 await expect(result(page)).toBeVisible();
}
async function select(page,channel) {await row(page,channel).getByRole('button').first().click();}
async function shows(page,pkg,channel) {
 await expect(result(page)).toContainText(`${pkg}_${channel}_SENTINEL`);
 await expect(result(page)).toContainText('Saved verbatim — Threads, Facebook and LinkedIn are valid references.');
 for(const other of platforms.filter(c=>c!==channel))await expect(result(page)).not.toContainText(`${pkg}_${other}_SENTINEL`);
 await expect(result(page)).not.toContainText('RUN_DISTRACTOR');
}
async function refresh(page) {
 const response=page.waitForResponse(r=>r.url().endsWith('/api/eb-v2/workspace'));
 // Workspace control sits behind the open detail overlay; invoke its real handler.
 await page.getByRole('button',{name:'Refresh V2 workspace',exact:true}).evaluate(button=>button.click());
 await response;
 await expect(panel(page).getByText('Loading source and AI activity…')).toHaveCount(0);
}
function clean(state) {expect(state.unexpected).toEqual([]);expect(state.errors).toEqual([]);}

test('G3_SINGLE_OUTPUT G3_CHANNEL_ISOLATION exact output IDs survive response reordering and package changes',async({page})=>{
 const state=await setup(page);
 // Configure the existing fixture's shared default object before opening TaskDetail.
 // This is page-local test state; all generation/mutation requests stay intercepted.
 await page.evaluate(async()=>{
  const {DEFAULT_CONFIG,DEFAULT_MODELS}=await import('/src/lib/defaultData.ts');
  DEFAULT_CONFIG.models=[{...DEFAULT_MODELS[0],id:'lab-ci-mock',name:'CI mock model',enabled:true}];
 });
 await open(page);
 for(const channel of platforms){await select(page,channel);await shows(page,'one',channel);}
 state.data.channels.reverse();await refresh(page);await shows(page,'one','linkedin');
 for(const channel of platforms){await select(page,channel);await shows(page,'one',channel);}
 await panel(page).locator('header button').click();await open(page,'two');
 await shows(page,'two','linkedin'); // reversed response's first eligible channel
 await expect(result(page)).not.toContainText('one_');
 for(const channel of platforms){await select(page,channel);await shows(page,'two',channel);}
 expect(state.mutations).toEqual([]);clean(state);
});

test('G3_SINGLE_OUTPUT G3_CHANNEL_FALLBACK removed IDs, hidden revisions, missing text and empty choices',async({page})=>{
 const state=await setup(page);await open(page);await select(page,'facebook');
 state.data.channels.find(r=>r.id==='one-facebook').content.feedbackPending=true;
 state.data.channels.find(r=>r.id==='one-linkedin').content.archived=true;
 await refresh(page);await shows(page,'one','threads');
 await expect(row(page,'facebook')).toHaveCount(0);await expect(row(page,'linkedin')).toHaveCount(0);
 // A removed choice must not resurrect when it becomes eligible again.
 state.data.channels.find(r=>r.id==='one-facebook').content.feedbackPending=false;
 await refresh(page);await shows(page,'one','threads');
 state.data.channels=state.data.channels.filter(r=>r.id!=='one-threads');
 await refresh(page);await shows(page,'one','facebook');
 delete state.data.channels.find(r=>r.id==='one-facebook').content.text;
 await refresh(page);await expect(result(page)).toContainText('This channel has not produced output yet.');
 await expect(result(page)).not.toContainText('SENTINEL');await expect(result(page)).not.toContainText('RUN_DISTRACTOR');
 state.data.channels.find(r=>r.id==='one-facebook').content.archived=true;
 await refresh(page);await expect(panel(page).locator('article')).toHaveCount(0);
 await expect(result(page)).toContainText('This channel has not produced output yet.');
 await expect(result(page)).not.toContainText('RUN_DISTRACTOR');
 expect(state.mutations).toEqual([]);clean(state);
});

test('G3_CHANNEL_ACTIONS verbatim copy/export and explicit per-ID review mutations',async({page})=>{
 const state=await setup(page);
 // Configure the existing fixture's shared default object before opening TaskDetail.
 // This is page-local test state; all generation/mutation requests stay intercepted.
 await page.evaluate(async()=>{
  const {DEFAULT_CONFIG,DEFAULT_MODELS}=await import('/src/lib/defaultData.ts');
  DEFAULT_CONFIG.models=[{...DEFAULT_MODELS[0],id:'lab-ci-mock',name:'CI mock model',enabled:true}];
 });
 await open(page);
 for(const channel of platforms) {
  await select(page,channel);await shows(page,'one',channel);
  await panel(page).getByTitle('Copy result as formatted Markdown',{exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__copied.at(-1))).toBe(text('one',channel));
  const download=page.waitForEvent('download');
  await panel(page).getByRole('button',{name:'Export .md',exact:true}).click();
  const file=await download;expect(file.suggestedFilename()).toBe('website-article.md');
  expect(await readFile(await file.path(),'utf8')).toBe(text('one',channel));
 }
 expect(state.mutations).toEqual([]);
 async function mutation(channel,action,trigger,extra={}) {
  const count=state.mutations.length;await trigger();
  await expect.poll(()=>state.mutations.length).toBe(count+1);
  expect(state.mutations[count]).toEqual({path:`/api/eb-v2/channel-outputs/one-${channel}/review`,body:{action,...extra}});
  await shows(page,'one',channel);
 }
 await mutation('facebook','done',()=>row(page,'facebook').getByRole('button',{name:'Mark Facebook done',exact:true}).click());
 await mutation('linkedin','reject',()=>row(page,'linkedin').getByRole('button',{name:'Reject LinkedIn',exact:true}).click());
 for(const variant of ['a','b','both'])await mutation('threads','done',()=>row(page,'threads').getByLabel('Approve Threads variants').selectOption(variant),{approvedVariants:variant});
 await row(page,'facebook').getByRole('button',{name:'More actions for Facebook',exact:true}).click();
 await mutation('facebook','recheck',()=>row(page,'facebook').getByRole('button',{name:'Send to recheck',exact:true}).click());
 await row(page,'linkedin').getByRole('button',{name:'More actions for LinkedIn',exact:true}).click();
 const count=state.mutations.length;
 await expect(row(page,'linkedin').getByRole('button',{name:'Regenerate',exact:true})).toBeEnabled();
 await row(page,'linkedin').getByRole('button',{name:'Regenerate',exact:true}).click();
 await expect.poll(()=>state.mutations.length).toBe(count+1);
 expect(state.mutations[count].path).toBe('/api/eb-v2/channel-outputs/one-linkedin/regenerate');
 expect(state.mutations[count].body.model).toEqual({provider:expect.any(String),id:expect.any(String)});
 clean(state);
});

test('G3_CHANNEL_ACTIONS missing model keeps Regenerate disabled without API calls',async({page})=>{
 const state=await setup(page);await open(page);
 await row(page,'linkedin').getByRole('button',{name:'More actions for LinkedIn',exact:true}).click();
 await expect(row(page,'linkedin').getByRole('button',{name:'Regenerate',exact:true})).toBeDisabled();
 expect(state.mutations).toEqual([]);clean(state);
});
