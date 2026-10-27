import {test as base,expect} from '@playwright/test';
export {expect};
export async function setTheme(page,theme){
 await page.locator('body').evaluate((body,theme)=>{
  body.classList.remove('codex-dark','writer-light');
  body.classList.add(theme==='dark'?'codex-dark':'writer-light');
 },theme);
}
export const test=base.extend({
 _offline:[async({context},use)=>{
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin==='http://127.0.0.1:4173'&&!url.pathname.startsWith('/api/'))return route.continue();
   if(url.origin==='https://fonts.googleapis.com')return route.fulfill({contentType:'text/css',body:'/* offline font fixture */'});
   return route.abort();
  });
  await use(undefined);
 },{auto:true}],
});
