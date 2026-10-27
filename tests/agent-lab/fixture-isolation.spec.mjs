import {test,expect,setTheme} from './browser-fixture.mjs';
for(const marker of ['first','second'])test(`fixture-isolation ${marker} has fresh state and offline APIs`,async({page})=>{
 await page.goto('/');
 await expect(page.locator('body')).toHaveClass(/writer-light/);
 expect(await page.evaluate(()=>localStorage.getItem('isolation-sentinel'))).toBeNull();
 await page.evaluate(()=>localStorage.setItem('isolation-sentinel','fixture'));
 const denied=await page.evaluate(async()=>{try{await fetch('/api/unmocked-fixture');return false;}catch{return true;}});
 expect(denied).toBe(true);
 await page.route('**/api/mocked-fixture',route=>route.fulfill({json:{fixture:true}}));
 expect(await page.evaluate(async()=>await(await fetch('/api/mocked-fixture')).json())).toEqual({fixture:true});
 await setTheme(page,'dark');
 await expect(page.locator('body')).toHaveClass(/codex-dark/);
 await expect(page.locator('body')).not.toHaveClass(/writer-light/);
});
