import {test,expect,setTheme} from './browser-fixture.mjs';
import {readFile} from 'node:fs/promises';
async function isolate(page){
 const unexpected=[];
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());
  // Keep the visual fixture offline; use the app's fallback font stack.
  if(u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2')return route.fulfill({contentType:'text/css',body:'/* offline font fixture */'});
  if(u.origin==='http://127.0.0.1:4173'&&u.pathname==='/api/eb-v2/workspace'&&route.request().method()==='GET')return route.fulfill({json:{packages:[{id:'ci-package',title:'CI_BRIEF_SENTINEL',state:'brief',source_type:'input'}],articles:[],channels:[],runs:[],discovery:[]}});
  if(u.origin==='http://127.0.0.1:4173'&&!u.pathname.startsWith('/api/'))return route.fallback();
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

// These scenarios run in both configured viewport projects in browser CI.
const creationStamp = '2026-01-02T23:04:00Z';
const branches = ['brief', 'article', 'drafting', 'adapt', 'review', 'empty'];
const articleStamp='2026-02-03T23:04:00Z', outputStamp='2026-03-04T23:04:00Z';
function expectedDate(branch,variant,timezoneId) {
 if(variant!=='valid'||branch==='drafting'||branch==='empty')return '—';
 const month=branch==='brief'?'01':branch==='article'?'02':'03';
 const day=(branch==='brief'?2:branch==='article'?3:4)+(timezoneId==='UTC'?0:1);
 return `${String(day).padStart(2,'0')}/${month}/2026 ${timezoneId==='UTC'?'23:04':'06:04'}`;
}
function creationWorkspace() {
 const packages=[],articles=[],channels=[];
 for (const branch of branches) for (const variant of ['valid','missing','invalid']) {
  const id=`${branch}-${variant}`;
  packages.push({id,title:`CREATED_${id}`,state:branch==='drafting'?'article':branch==='empty'?'review':branch,source_type:'input',
   ...(variant==='missing'?{}:{created_at:variant==='valid'?creationStamp:'invalid-timestamp'}),updated_at:'2030-06-07T08:09:00Z'});
  if(branch==='article')articles.push(
   {id:`article-${id}`,package_id:id,status:'draft',revision:3,created_at:variant==='valid'?articleStamp:variant==='invalid'?'invalid':undefined},
   {id:`old-${id}`,package_id:id,status:'superseded',revision:2,created_at:'2035-01-01T00:00:00Z'},
   {id:`pending-${id}`,package_id:id,status:'draft',quality_report:{feedbackPending:true},created_at:'2035-01-01T00:00:00Z'});
  if(branch==='adapt'||branch==='review')channels.push({id:`channel-${id}`,package_id:id,channel:'linkedin',status:branch==='adapt'?'generating':'ready',created_at:variant==='valid'?outputStamp:variant==='invalid'?'invalid':undefined,content:{}});
  if(branch==='review')channels.push(
   {id:`older-${id}`,package_id:id,channel:'facebook',status:'ready',created_at:variant==='valid'?articleStamp:'invalid',content:{}},
   {id:`archived-${id}`,package_id:id,channel:'threads',status:'ready',created_at:'2035-01-01T00:00:00Z',content:{archived:true}},
   {id:`pending-${id}`,package_id:id,channel:'threads',status:'ready',created_at:'2036-01-01T00:00:00Z',content:{feedbackPending:true}});
 }
 return {packages,articles,channels,runs:[],discovery:[]};
}
async function isolateCreation(page) {
 const unexpected=[];let refresh=0;
 await page.route('**/*',route=>{
  const request=route.request(),u=new URL(request.url());
  if(u.origin==='https://fonts.googleapis.com'&&u.pathname==='/css2')return route.fulfill({contentType:'text/css',body:''});
  if(u.origin==='http://127.0.0.1:4173') {
   if(request.method()==='GET'&&u.pathname==='/api/eb-v2/workspace'){const data=creationWorkspace();if(refresh++%2)data.channels.reverse();return route.fulfill({json:data});}
   if(request.method()==='GET'&&u.pathname.startsWith('/api/eb-v2/activity/'))return route.fulfill({json:{inputs:[],runs:[],actions:[],feedback:[]}});
   if(!u.pathname.startsWith('/api/')&&request.method()==='GET')return route.fallback();
  }
  unexpected.push(`${request.method()} ${u.origin}${u.pathname}`);return route.abort();
 });
 return unexpected;
}
async function creationView(page,view) {
 const control=page.getByRole('button',{name:view==='grid'?'Grid view':'List view',exact:true});
 await expect(control).toBeEnabled();await control.click();
}
for (const timezoneId of ['UTC','Asia/Ho_Chi_Minh']) {
 test.describe(`creation values ${timezoneId}`,()=>{
  test.use({timezoneId});
  test('GATE_DATE_SOURCE entity timestamps across gates and views',async({page})=>{
   const unexpected=await isolateCreation(page);
   await page.goto('/?screen=eb');
   for(const view of ['list','grid']) {
    await creationView(page,view);
    for(const branch of branches)for(const variant of ['valid','missing','invalid']) {
     const card=page.locator('article').filter({has:page.getByRole('button',{name:`Open task: CREATED_${branch}-${variant}`,exact:true})});
     const date = view === 'grid'
      ? `Ngày tạo: ${expectedDate(branch,variant,timezoneId)}`
      : timezoneId === 'UTC' ? '07/06/2030 08:09' : '07/06/2030 15:09';
     await expect(card.locator('.eb-task-date')).toHaveText(date);
    }
    const response=page.waitForResponse(r=>r.url().endsWith('/api/eb-v2/workspace'));
    await page.getByRole('button',{name:'Refresh V2 workspace',exact:true}).click();await response;
    for(const branch of branches)for(const variant of ['valid','missing','invalid']) {
     const card=page.locator('article').filter({has:page.getByRole('button',{name:`Open task: CREATED_${branch}-${variant}`,exact:true})});
     const date = view === 'grid'
      ? `Ngày tạo: ${expectedDate(branch,variant,timezoneId)}`
      : timezoneId === 'UTC' ? '07/06/2030 08:09' : '07/06/2030 15:09';
     await expect(card.locator('.eb-task-date')).toHaveText(date);
    }
   }
   expect(unexpected).toEqual([]);
  });
 });
}
for(const theme of ['light','dark'])for(const view of ['list','grid']) {
 test(`GATE_DATE_STABILITY ${theme} ${view} metadata and controls`,async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const unexpected=await isolateCreation(page);await page.goto('/?screen=eb');
  await setTheme(page,theme);
  await creationView(page,view);
  const dateValues=()=>page.locator('article').evaluateAll(cards=>cards.map(card=>({title:card.querySelector('[aria-label^="Open task:"]')?.getAttribute('aria-label'),date:card.querySelector('.eb-task-date')?.textContent})).sort((a,b)=>a.title.localeCompare(b.title)));
  await expect(page.getByRole('button',{name:'Open task: CREATED_brief-valid',exact:true})).toBeVisible();
  const dates=await dateValues();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/eb-v2/workspace'));
  const refresh=page.getByRole('button',{name:'Refresh V2 workspace',exact:true});
  await expect(refresh).toBeEnabled();await refresh.click();await response;
  await expect.poll(dateValues).toEqual(dates);
  for(const branch of branches) {
   const title=`CREATED_${branch}-valid`;
   const open=page.getByRole('button',{name:`Open task: ${title}`,exact:true});
   const card=page.locator('article').filter({has:open}),metadata=card.locator('.eb-task-date');
   await metadata.scrollIntoViewIfNeeded();
   const {dateBox,cardBox,controls}=await card.evaluate((el,title)=>{
    const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {cardBox:box(el),dateBox:box(el.querySelector('.eb-task-date')),controls:[...el.querySelectorAll('button')].filter(b=>b.getAttribute('aria-label')!==`Open task: ${title}`).map(box)};
   },title);
   expect(dateBox.width).toBeGreaterThan(0);
   expect(dateBox.x).toBeGreaterThanOrEqual(cardBox.x);
   expect(dateBox.x+dateBox.width).toBeLessThanOrEqual(cardBox.x+cardBox.width);
   expect(dateBox.y+dateBox.height).toBeLessThanOrEqual(cardBox.y+cardBox.height);
   for(const box of controls)expect(box.x>=dateBox.x+dateBox.width||box.x+box.width<=dateBox.x||box.y>=dateBox.y+dateBox.height||box.y+box.height<=dateBox.y).toBeTruthy();
   const menu=card.getByRole('button',{name:'More item actions'});
   await expect(menu).toBeEnabled();await menu.click();await expect(menu).toHaveAttribute('aria-expanded','true');
   await expect(page.getByRole('dialog',{name:'Task actions'}).getByRole('button',{name:'Delete item'})).toBeVisible();
   await expect(page.locator('aside').filter({has:page.getByRole('heading',{name:title,exact:true})})).toHaveCount(0);
   await page.keyboard.press('Escape');await expect(menu).toHaveAttribute('aria-expanded','false');
   await menu.click();await menu.click();await expect(menu).toHaveAttribute('aria-expanded','false');
   for(const action of ['click','Enter','Space']) {
    await expect(open).toBeEnabled();
    if(action==='click')await metadata.click();else {await open.focus();await expect(open).toBeFocused();await open.press(action);}
    const detail=page.locator('aside').filter({has:page.getByRole('heading',{name:title,exact:true})});
    await expect(detail).toBeVisible();
    await detail.getByRole('button',{name:'Close task details',exact:true}).click();await expect(detail).toHaveCount(0);
   }
  }
  expect(errors).toEqual([]);expect(unexpected).toEqual([]);
 });
}

test('Gate sorting, title limits and modal backdrop work in both workspace views', async ({page}, info) => {
 const longTitle = 'Newest package with a long title '.repeat(12).trim();
 const packages = [
  {id:'old',title:'Old package',state:'brief',created_at:'2025-01-01T00:00:00Z'},
  {id:'new',title:longTitle,state:'brief',created_at:'2025-06-01T00:00:00Z'},
  {id:'unknown',title:'Undated package',state:'brief'},
 ];
 await page.route('**/api/eb-v2/workspace',route=>route.fulfill({json:{packages,articles:[],runs:[],channels:[],discovery:[]}}));
 const opened = [];
 await page.route('**/api/eb-v2/activity/*',route=>{
  opened.push(new URL(route.request().url()).pathname.split('/').at(-1));
  return route.fulfill({json:{inputs:[],runs:[],actions:[],feedback:[]}});
 });
 if (info.project.name === 'desktop') await page.setViewportSize({width:1440,height:900});
 await page.goto('/?screen=eb');
 const titles = page.locator('.eb-board-body h3');
 await expect(titles).toHaveText([longTitle,'Old package','Undated package']);
 await expect(titles.first()).toHaveCSS('text-overflow','ellipsis');
 await expect(titles.first()).toHaveCSS('white-space','nowrap');
 const sort = page.getByRole('combobox',{name:'Sắp xếp theo ngày tạo'});
 const filter = page.getByRole('button',{name:'Filter',exact:true});
 await expect(sort).toHaveClass(/app-dropdown-trigger/);
 const filterTrigger = await filter.boundingBox();
 const sortTrigger = await sort.boundingBox();
 expect(sortTrigger.y).toBe(filterTrigger.y);
 expect(sortTrigger.height).toBe(filterTrigger.height);
 await filter.click();
 const filterPopup = page.getByRole('dialog',{name:'Filter packages'});
 const filterWidth = (await filterPopup.boundingBox()).width;
 await page.keyboard.press('Escape');
 await sort.click();
 const options = page.getByRole('listbox',{name:'Sắp xếp theo ngày tạo'});
 await expect(options).toBeVisible();
 const sortPopup = options.locator('xpath=ancestor::*[contains(@class,"app-dropdown-popup")]');
 expect((await sortPopup.boundingBox()).width).toBe(filterWidth);
 await page.screenshot({path:info.outputPath('sort-dropdown.png'),animations:'disabled'});
 await options.getByRole('option',{name:'Cũ nhất'}).click();
 await expect(titles).toHaveText(['Old package',longTitle,'Undated package']);
 await page.getByRole('button',{name:'Grid view',exact:true}).click();
 await expect(titles).toHaveText(['Old package',longTitle,'Undated package']);
 await expect(titles.nth(1)).toHaveCSS('-webkit-line-clamp','3');
 await expect(page.locator('.eb-task-status').first()).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
 const trigger = page.getByRole('button',{name:'Open task: Old package',exact:true});
 const coveredTitle = await titles.nth(1).boundingBox();
 await trigger.click();
 const detail = page.getByRole('dialog',{name:'Old package',exact:true});
 await expect(detail).toBeVisible();
 const backdrop = page.locator('.eb-task-inspector');
 if (info.project.name === 'desktop') await page.mouse.click(coveredTitle.x + 8, coveredTitle.y + 8);
 else await backdrop.click({position:{x:3,y:60}});
 await expect(detail).toBeHidden();
 await expect(trigger).toBeFocused();
 expect(opened).toEqual(['old']);
});
