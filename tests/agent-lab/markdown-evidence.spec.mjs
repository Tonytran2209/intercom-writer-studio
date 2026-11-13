import {test,expect} from './browser-fixture.mjs';

test('Discovery goes directly to Gate 1 and waits for a validated brief', async ({page}) => {
 const idea = {id:'idea-web',status:'suggested',title:'Learning workshop'};
 const data = {packages:[],runs:[],articles:[],channels:[],discovery:[idea]};
 const error = 'Chưa tìm thấy dẫn chứng F phù hợp.';
 let promotions = 0;
 await page.route('**/api/**', route => {
  const path = new URL(route.request().url()).pathname;
  if(path.endsWith('/workspace')) return route.fulfill({json:data});
  if(path.endsWith('/promote')) {
   expect(route.request().postDataJSON().model.id).toBe('evidence-fixture');
   promotions++;
   data.packages = [{id:idea.id,title:idea.title,state:'brief',source_type:'discovery'}];
   Object.assign(idea,{status:'used',package_id:idea.id});
   data.runs = promotions === 1
    ? [{package_id:idea.id,gate:'brief',stage:'discovery-evidence',status:'failed',error_message:error}]
    : [{package_id:idea.id,gate:'brief',stage:'extract_mapping',status:'completed',output_snapshot:{content:'Validated brief'}}];
   return route.fulfill({status:201,json:{packageId:idea.id}});
  }
  if(path.includes('/activity/')) return route.fulfill({json:{runs:data.runs,inputs:promotions === 2
   ? [{raw_snapshot:{briefValidation:{connection:'F organized the workshop.',evidence:'workshop.md\nVerified workshop quote'}}}]
   : []}});
  return route.abort();
 });
 await page.goto('/?screen=eb');
 await page.evaluate(async () => {
  const {DEFAULT_CONFIG,DEFAULT_MODELS} = await import('/src/lib/defaultData.ts');
  DEFAULT_CONFIG.models = [{...DEFAULT_MODELS[0],id:'evidence-fixture',enabled:true}];
 });
 await page.getByRole('button',{name:'Refresh V2 workspace',exact:true}).click();
 await expect(page.getByRole('button',{name:'Refresh V2 workspace',exact:true})).toBeEnabled();
 await page.locator('#eb-input').fill('Unrelated draft');
 await page.evaluate(() => window.dispatchEvent(new CustomEvent('writer:eb-open',{detail:'discovery'})));
 await page.getByRole('button',{name:'Chuyển sang Gate 1',exact:true}).click();
 await expect(page.getByRole('button',{name:'Open task: Learning workshop',exact:true})).toBeVisible();
 await expect(page.locator('#eb-input')).toHaveValue('Unrelated draft');
 const detail = page.locator('aside');
 if (page.viewportSize().width >= 1024) await page.setViewportSize({width:1440,height:900});
 await expect(page.locator('.eb-task-inspector')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
 await expect(detail.getByText(error,{exact:true}).first()).toBeVisible();
 await expect(detail.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await detail.getByRole('button',{name:'Tìm lại dẫn chứng F',exact:true}).click();
 await expect(detail.getByRole('button',{name:'Approve',exact:true})).toBeEnabled();
 await expect(detail.getByText('workshop.md Verified workshop quote',{exact:true})).toBeVisible();
 const evidenceTab=detail.getByRole('tab',{name:'Dẫn chứng',exact:true});
 await expect(evidenceTab.getByText('Dẫn chứng',{exact:true})).toHaveCSS('font-size','13px');
 await expect(evidenceTab).toHaveAttribute('aria-selected','true');
 await evidenceTab.focus();
 await page.keyboard.press('ArrowRight');
 await expect(detail.getByRole('tab',{name:'Lịch sử',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(detail.getByRole('heading',{name:'AI activity log',exact:true})).toBeVisible();
 await detail.getByRole('tab',{name:'Brief',exact:true}).click();
 await expect(detail.getByText('Validated brief',{exact:true})).toHaveCSS('font-size','14px');
 expect(await detail.locator('.eb-task-inspector-content').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
 await expect(detail.getByRole('button',{name:'Approve',exact:true})).toBeEnabled();
 await expect(detail.getByLabel('Dẫn chứng / nguồn xác nhận tại F')).toHaveCount(0);
 await expect(page.getByLabel('Ảnh dẫn chứng')).toHaveCount(0);
});

test('Discovery source trace keeps long links inside the detail panel', async ({ page }) => {
 const url = 'https://example.com/redirect/' + 'AbCd0123'.repeat(180);
 const idea = {id:'long-source',title:'Research with a long source link',status:'suggested'};
 await page.route('**/api/eb-v2/workspace', route => route.fulfill({
  json:{packages:[],runs:[],articles:[],channels:[],discovery:[idea]},
 }));
 await page.route('**/api/eb-v2/discovery/long-source/details', route => route.fulfill({
  json:{item:idea,sources:[
   {source_name:'Web research',url},
   {source_name:'Internal evidence',sourcePath:'Research/'.repeat(180)},
  ]},
 }));
 await page.goto('/?screen=eb');
 await page.evaluate(() => window.dispatchEvent(new CustomEvent('writer:eb-open',{detail:'discovery'})));
 await page.getByRole('button',{name:'Details',exact:true}).click();
 const panel = page.locator('.eb-discovery-detail');
 await expect(panel).toHaveAttribute('role','dialog');
 await expect(panel.locator('.eb-inspector-gate')).toBeVisible();
 await expect(panel.getByRole('heading',{name:idea.title,exact:true})).toHaveCSS('font-size','16px');
 await expect(panel.getByRole('heading',{name:'Sources used'})).toBeVisible();
 await expect(panel.getByRole('link',{name:'example.com',exact:true})).toHaveAttribute('href',url);
 await expect(panel.getByText('Internal evidence',{exact:true})).toBeVisible();
 expect(await panel.evaluate(node =>
  [node, ...node.querySelectorAll('section, .overflow-y-auto')].every(element => element.scrollWidth <= element.clientWidth)
 )).toBe(true);
 await page.keyboard.press('Escape');
 await expect(panel).toHaveCount(0);
});

test('Discovery toolbar passes pasted links and distinguishes empty scans from interrupted scans', async ({page}) => {
 const idea = {id:'saved',title:'Previously saved suggestion',status:'suggested'};
 const links = ['https://www.threads.com/@source/post/1','https://www.instagram.com/p/source/'];
 const requests = [];
 await page.route('**/api/eb-v2/workspace', route => route.fulfill({
  json:{packages:[],runs:[],articles:[],channels:[],discovery:[idea]},
 }));
 await page.route('**/api/eb-v2/discovery', route => {
  requests.push(route.request().postDataJSON());
  const event = requests.length === 1
   ? {event:'complete',items:[],coverage:[{status:'failed'}]}
   : {event:'progress',message:'Scanning configured sources…'};
  return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify(event)+'\n'});
 });
 await page.goto('/?screen=eb');
 await page.evaluate(async () => {
  const {DEFAULT_CONFIG,DEFAULT_MODELS} = await import('/src/lib/defaultData.ts');
  DEFAULT_CONFIG.models = [{...DEFAULT_MODELS[0],enabled:true}];
  window.dispatchEvent(new CustomEvent('writer:eb-open',{detail:'discovery'}));
 });
 const toolbar = page.getByRole('group',{name:'Discovery actions'});
 await expect(toolbar.getByRole('button',{name:'Scan sources',exact:true})).toHaveCSS('font-size','13px');
 await expect(toolbar.getByRole('button',{name:'Clear all'})).toBeEnabled();
 await toolbar.getByRole('button',{name:'Paste links',exact:true}).click();
 const picker = page.getByRole('dialog',{name:'Discovery source links'});
 await picker.getByLabel('Source links').fill(links.join('\n'));
 const done = picker.getByRole('button',{name:'Done',exact:true});
 await expect(done.getByText('Done',{exact:true})).toHaveCSS('font-size','13px');
 await done.click();
 await expect(picker).toBeHidden();
 await expect(toolbar.getByRole('button',{name:'Paste links (2)',exact:true})).toBeVisible();
 const scan = toolbar.getByRole('button',{name:'Scan sources',exact:true});
 await scan.click();
 await expect(page.getByRole('status').filter({hasText:'Scan completed with no new suggestions'})).toContainText('1 source fetch failed');
 await expect(page.getByRole('heading',{name:idea.title})).toBeVisible();
 expect(requests[0].sourceUrls).toEqual(links);
 await scan.click();
 await expect(page.getByRole('status').filter({hasText:'Scan could not finish'})).toContainText('before Discovery confirmed completion');
 await expect(page.getByRole('heading',{name:idea.title})).toBeVisible();
 await toolbar.getByRole('button',{name:'Back to workspace'}).click();
 await expect(page.getByRole('heading',{name:'EB Content Packages'})).toBeVisible();
});
