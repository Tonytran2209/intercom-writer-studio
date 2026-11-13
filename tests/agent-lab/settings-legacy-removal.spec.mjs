import {test,expect} from './browser-fixture.mjs';

test('Settings exposes current sources and preserves synthetic legacy files on save',async({page})=>{
 let document = null;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/eb-v2/markdown-evidence' && route.request().method()==='POST') {
   expect(route.request().postDataBuffer().toString()).toContain('evidence.md');
   document = {name:'evidence.md',uploadedAt:'2026-11-11T00:00:00Z'};
   return route.fulfill({status:201,json:{document}});
  }
  const bodies={
   '/api/eb-v2/library-documents':{documents:[{id:'library-fixture',name:'fixture-library.md',content:'Library sentinel',updated_at:'2026-01-01'}]},
   '/api/eb-v2/learning-signals':{signals:[]},
   '/api/website-inventory':{records:[]},
   '/api/eb-v2/markdown-evidence':{document},
  };
  if(!bodies[path])throw new Error(`Unexpected fixture API: ${path}`);
  await route.fulfill({json:bodies[path]});
 });
 await page.goto('/?screen=settings');
 const footer = page.locator('.settings-footer');
 for (const name of [/^(Huỷ|Cancel)$/, /^(Lưu thay đổi|Save changes)$/]) {
  const action = footer.getByRole('button',{name});
  await expect(action).toHaveCSS('font-size','13px');
  await expect(action.getByText(name)).toHaveCSS('font-size','13px');
 }
 const nav=page.locator('.settings-subnav');
 await expect(nav.getByRole('button')).toHaveText(['EB Library','EB Workflow Rules','Website Inventory']);
 await expect(page.getByText('fixture-library.md',{exact:true})).toBeVisible();
 const collection = page.getByRole('button',{name:/EVP Pillars/});
 await collection.click();
 const detail = page.getByRole('dialog',{name:'EVP Pillars',exact:true});
 await expect(detail.locator('.eb-inspector-gate')).toHaveText('EB Library collection');
 await expect(detail.getByRole('heading',{name:'Collection purpose'})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(detail).toHaveCount(0);

 const upload = page.getByRole('button',{name:'Tải tệp Markdown',exact:true});
 await expect(upload).toBeEnabled();
 await upload.focus();
 const [chooser] = await Promise.all([page.waitForEvent('filechooser'),page.keyboard.press('Enter')]);
 await chooser.setFiles({name:'evidence.md',mimeType:'text/markdown',buffer:Buffer.from('# F evidence')});
 await expect(page.getByRole('button',{name:'Thay tệp Markdown',exact:true})).toBeEnabled();
 await expect(page.getByText(/evidence\.md/)).toBeVisible();
 await expect(page.getByText(/Legacy Action Plan/)).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Download fixture-action/})).toHaveCount(0);
 await nav.getByRole('button',{name:'EB Workflow Rules',exact:true}).click();
 await expect(page.getByText('F.Learning EB Article Writer',{exact:true})).toBeVisible();
 await nav.getByRole('button',{name:'Website Inventory',exact:true}).click();
 await expect(page.getByPlaceholder('Search URL, title, topic or service…')).toBeVisible();
 const type = page.getByRole('combobox',{name:'Filter by page type'});
 await type.focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('listbox',{name:'Filter by page type'})).toBeVisible();
 await page.keyboard.press('ArrowDown');
 await page.keyboard.press('Enter');
 await expect(type).toHaveText('Blog');
 await expect(type).toBeFocused();
 await nav.getByRole('button',{name:'EB Library',exact:true}).click();
 await expect(page.getByText('fixture-library.md',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/^(Lưu thay đổi|Save changes)$/}).click();
 const saved=JSON.parse(await page.getByTestId('saved-settings').textContent());
 for(const category of ['action','action-plan','rules']){
  expect(saved.files.find(file=>file.id===`fixture-${category}`)).toEqual({id:`fixture-${category}`,name:`fixture-${category}.txt`,category,fileType:'txt',size:'17 B',uploadedAt:'2026-01-01',content:`sentinel-${category}`});
 }
 expect(saved.files.some(file=>file.id==='library-fixture')).toBe(true);
});
