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
