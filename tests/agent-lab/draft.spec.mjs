import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
async function isolate(page){
 const unexpected=[];
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());
  // Keep the visual fixture offline; use the app's fallback font stack.
  if(u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2')return route.fulfill({contentType:'text/css',body:'/* offline font fixture */'});
  if(u.origin==='http://127.0.0.1:4173'&&u.pathname==='/api/eb-v2/workspace'&&route.request().method()==='GET')return route.fulfill({json:{packages:[{id:'ci-package',title:'CI_BRIEF_SENTINEL',state:'brief',source_type:'input'}],articles:[],channels:[],runs:[],discovery:[]}});
  if(u.origin==='http://127.0.0.1:4173'&&!u.pathname.startsWith('/api/'))return route.continue();
  unexpected.push(u.origin+u.pathname);return route.abort();
 });return unexpected;
}
test('Draft editing, persistence callback and exported text agree',async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));const unexpected=await isolate(page);await page.goto('/');
 await expect(page.getByRole('heading',{name:/Bản nháp|Draft/}).first()).toBeVisible();
 const source=page.getByTestId('stored-source'),initial=await source.textContent();
 expect(initial).toContain('BODY_SENTINEL');expect(initial).toContain('CONCLUSION_SENTINEL');
 const edit=page.getByRole('button',{name:/Chỉnh sửa toàn bộ bản nháp|Edit full draft/});if(await edit.count())await edit.click();
 const editor=page.locator('[contenteditable="true"]');await expect(editor).toBeVisible();await expect(editor).toContainText('BODY_SENTINEL');await expect(editor).toContainText('CONCLUSION_SENTINEL');
 await editor.press('ControlOrMeta+End');await editor.press('End');await editor.pressSequentially(' EDIT_SENTINEL');await expect(source).toContainText('EDIT_SENTINEL');
 const saved=await source.textContent();expect(saved.replace(' EDIT_SENTINEL','')).toBe(initial);expect(saved).toContain('—');
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:/Tải .txt|Download .txt/}).click();expect(await readFile(await(await downloaded).path(),'utf8')).toBe(saved);
 await page.screenshot({path:info.outputPath('draft.png'),fullPage:true});expect(errors).toEqual([]);expect(unexpected).toEqual([]);
});
test('EB V2 loads an isolated Brief workspace',async({page},info)=>{const errors=[];page.on('pageerror',e=>errors.push(e.message));const unexpected=await isolate(page);await page.goto('/?screen=eb');await expect(page.getByText('CI_BRIEF_SENTINEL').first()).toBeVisible();await page.screenshot({path:info.outputPath('eb-v2.png'),fullPage:true});expect(errors).toEqual([]);expect(unexpected).toEqual([]);});

// Run with both desktop/mobile projects in playwright.agent-lab.config.mjs.
const createdAt='2026-01-02T20:04:00Z';
function timestampWorkspace(){
 const packages=['brief','article','adapt','review','drafting'].map(state=>({id:state,title:`CREATED_${state}`,state:state==='drafting'?'article':state,created_at:createdAt,source_type:'input'}));
 return {packages,articles:[{id:'article-row',package_id:'article',status:'draft',created_at:'2026-06-06T00:00:00Z'}],channels:[{id:'adapt-row',package_id:'adapt',channel:'facebook',status:'generating',created_at:'2026-07-07T00:00:00Z'},{id:'review-row',package_id:'review',channel:'facebook',status:'ready',created_at:'2026-08-08T00:00:00Z'}],runs:[],discovery:[]};
}
async function timestampFixture(page,data){
 const unexpected=[],writes=[];
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin==='https://fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:''});
  if(url.origin==='http://127.0.0.1:4173'){
   if(!url.pathname.startsWith('/api/'))return route.continue();
   if(req.method()==='GET'&&url.pathname==='/api/eb-v2/workspace')return route.fulfill({json:data});
   if(req.method()==='GET'&&url.pathname.startsWith('/api/eb-v2/activity/'))return route.fulfill({json:{}});
   if(req.method()==='POST'&&/\/packages\/(brief\/approve-brief|article\/approve-article)$/.test(url.pathname)){
    writes.push({path:url.pathname,body:req.postDataJSON()});return route.fulfill({json:data});
   }
   if(req.method()==='POST'&&url.pathname==='/api/eb-v2/channel-outputs/review-row/review'){
    writes.push({path:url.pathname,body:req.postDataJSON()});return route.fulfill({json:data});
   }
  }
  unexpected.push(`${req.method()} ${url.pathname}`);return route.abort();
 });
 return {unexpected,writes};
}
const taskCard=(page,title)=>page.locator('article').filter({has:page.getByRole('button',{name:`Open task: ${title}`,exact:true})});

test.describe('Created timestamps',()=>{
 test.use({timezoneId:'Asia/Ho_Chi_Minh'});
 test('created-origin package dates survive refresh and simulated gate moves',async({page})=>{
  const data=timestampWorkspace(),audit=await timestampFixture(page,data);
  await page.goto('/?screen=eb');
  for(const row of data.packages){
   const time=taskCard(page,row.title).locator('time');
   await expect(time).toHaveText('03/01/2026 03:04');
   await expect(time).toHaveAttribute('datetime','2026-01-02T20:04:00.000Z');
   await expect(time.locator('..')).toHaveText('Created 03/01/2026 03:04');
  }
  data.packages.find(row=>row.id==='brief').state='article';
  await page.getByRole('button',{name:'Refresh V2 workspace',exact:true}).click();
  await expect(taskCard(page,'CREATED_brief').getByText('Drafting',{exact:true})).toBeVisible();
  await expect(taskCard(page,'CREATED_brief').locator('time')).toHaveText('03/01/2026 03:04');
  await page.reload();
  await expect(taskCard(page,'CREATED_brief').locator('time')).toHaveText('03/01/2026 03:04');
  expect(audit.writes).toEqual([]);expect(audit.unexpected).toEqual([]);
 });
 test('created-invalid missing empty and invalid timestamps stay absent and cards open',async({page})=>{
  const data=timestampWorkspace();
  data.packages=data.packages.slice(0,3).map((row,index)=>({...row,state:'brief',created_at:[undefined,'','bad timestamp'][index]}));
  data.articles=[];data.channels=[];
  const audit=await timestampFixture(page,data);await page.goto('/?screen=eb');
  for(const row of data.packages){
   const card=taskCard(page,row.title);await expect(card).toBeVisible();await expect(card.locator('time')).toHaveCount(0);
   await expect(card).not.toContainText(/Created|Invalid Date/);
   await card.getByRole('button',{name:`Open task: ${row.title}`,exact:true}).click();
   await expect(page.locator('aside').getByRole('heading',{name:row.title,exact:true})).toBeVisible();
   await page.locator('aside > header button').click();
  }
  expect(audit.writes).toEqual([]);expect(audit.unexpected).toEqual([]);
 });
 for(const theme of ['light','dark'])for(const view of ['list','grid']){
  test(`created-layout ${theme} ${view} date click and independent actions`,async({page},info)=>{
   const audit=await timestampFixture(page,timestampWorkspace());await page.goto('/?screen=eb');
   await page.evaluate(theme=>{document.documentElement.className=theme==='light'?'writer-light':'codex-dark';},theme);
   // Existing view buttons have Lucide icons rather than accessible names.
   await page.locator(`button:has(svg.lucide-${view==='grid'?'grid-2x2':'list'})`).click();
   for(const name of ['brief','article','adapt','review','drafting']){
    const card=taskCard(page,`CREATED_${name}`),time=card.locator('time');await expect(time).toBeVisible();
    const bounds=await card.boundingBox(),dateBounds=await time.boundingBox();
    expect(dateBounds.x).toBeGreaterThanOrEqual(bounds.x);expect(dateBounds.x+dateBounds.width).toBeLessThanOrEqual(bounds.x+bounds.width+1);
    await time.click();await expect(page.locator('aside').getByRole('heading',{name:`CREATED_${name}`,exact:true})).toBeVisible();
    if(name==='review'){
     await page.getByRole('button',{name:'Mark Facebook done',exact:true}).click();
     await expect.poll(()=>audit.writes.length).toBe(1);
     expect(audit.writes.at(-1)).toEqual({path:'/api/eb-v2/channel-outputs/review-row/review',body:{action:'done'}});
    }
    await page.locator('aside > header button').click();
    await card.getByRole('button',{name:'More item actions',exact:true}).click();
    await expect(card.getByRole('button',{name:'Delete item',exact:true})).toBeVisible();await expect(page.locator('aside')).toHaveCount(0);
    await page.keyboard.press('Escape');
   }
   await taskCard(page,'CREATED_brief').getByRole('button',{name:'Approve brief',exact:true}).click();
   await expect.poll(()=>audit.writes.some(row=>row.path.endsWith('/brief/approve-brief'))).toBe(true);
   await expect(page.locator('aside')).toHaveCount(0);
   await taskCard(page,'CREATED_article').getByRole('button',{name:'Approve article',exact:true}).click();
   await expect.poll(()=>audit.writes.some(row=>row.path.endsWith('/article/approve-article'))).toBe(true);
   await expect(page.locator('aside')).toHaveCount(0);
   expect(audit.unexpected).toEqual([]);
   await page.screenshot({path:info.outputPath(`created-${theme}-${view}.png`),fullPage:true});
  });
 }
});
