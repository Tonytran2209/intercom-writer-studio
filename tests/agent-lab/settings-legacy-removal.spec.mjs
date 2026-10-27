import {test,expect} from '@playwright/test';

test('Settings exposes current sources and preserves synthetic legacy files on save',async({page})=>{
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const bodies={
   '/api/eb-v2/library-documents':{documents:[{id:'library-fixture',name:'fixture-library.md',content:'Library sentinel',updated_at:'2026-01-01'}]},
   '/api/eb-v2/learning-signals':{signals:[]},
   '/api/website-inventory':{records:[]},
  };
  if(!bodies[path])throw new Error(`Unexpected fixture API: ${path}`);
  await route.fulfill({json:bodies[path]});
 });
 await page.goto('/?screen=settings');
 const nav=page.locator('.settings-subnav');
 await expect(nav.getByRole('button')).toHaveText(['EB Library','EB Workflow Rules','Website Inventory']);
 await expect(page.getByText('fixture-library.md',{exact:true})).toBeVisible();
 await expect(page.getByText(/Legacy Action Plan/)).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Download fixture-action/})).toHaveCount(0);
 await nav.getByRole('button',{name:'EB Workflow Rules',exact:true}).click();
 await expect(page.getByText('F.Learning EB Article Writer',{exact:true})).toBeVisible();
 await nav.getByRole('button',{name:'Website Inventory',exact:true}).click();
 await expect(page.getByPlaceholder('Search URL, title, topic or service…')).toBeVisible();
 await nav.getByRole('button',{name:'EB Library',exact:true}).click();
 await expect(page.getByText('fixture-library.md',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/^(Lưu thay đổi|Save changes)$/}).click();
 const saved=JSON.parse(await page.getByTestId('saved-settings').textContent());
 for(const category of ['action','action-plan','rules']){
  expect(saved.files.find(file=>file.id===`fixture-${category}`)).toEqual({id:`fixture-${category}`,name:`fixture-${category}.txt`,category,fileType:'txt',size:'17 B',uploadedAt:'2026-01-01',content:`sentinel-${category}`});
 }
 expect(saved.files.some(file=>file.id==='library-fixture')).toBe(true);
});
