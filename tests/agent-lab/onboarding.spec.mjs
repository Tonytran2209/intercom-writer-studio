import {test,expect} from './browser-fixture.mjs';

// Synthetic empty workspace validates shell behavior, not a production sample.
async function openApp(page,{storageFailure=false,seen=false,english=false}={}){
 const writes=[];
 await page.addInitScript(({storageFailure,seen,english})=>{
  if(seen)localStorage.setItem('writer:onboarding:v1','seen');
  if(english)localStorage.setItem('writer:language','en');
  // Isolate failures to the new key: the existing language provider reads its own key.
  if(storageFailure){
   for(const method of ['getItem','setItem']){
    const original=Storage.prototype[method];
    Storage.prototype[method]=function(key,...args){
     if(key==='writer:onboarding:v1')throw new DOMException('Blocked','SecurityError');
     return original.call(this,key,...args);
    };
   }
  }
 },{storageFailure,seen,english});
 await page.route('**/api/**',route=>{
  const request=route.request();
  if(request.method()!=='GET'){writes.push(request.url());return route.abort();}
  const path=new URL(request.url()).pathname;
  if(path==='/api/eb-v2/settings')return route.fulfill({json:{settings:null}});
  if(path==='/api/eb-v2/workspace')return route.fulfill({json:{packages:[],articles:[],channels:[],discovery:[]}});
  return route.fallback();
 });
 await page.goto('/?screen=onboarding');
 return writes;
}
const guide=page=>page.getByRole('button',{name:'Hướng dẫn',exact:true});
const dialog=page=>page.getByRole('dialog');

for(const dismissal of ['skip','close','escape','finish']){
 test(`first visit, ${dismissal}, reload and reopen preserves input`,async({page})=>{
  const writes=await openApp(page);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAccessibleName('Bắt đầu từ ý tưởng thật');
  expect(await page.evaluate(()=>localStorage.getItem('writer:onboarding:v1'))).toBeNull();
  await page.getByRole('button',{name:'Tiếp',exact:true}).click();
  await expect(dialog(page)).toHaveAccessibleName('Đi từng bước, duyệt từng Gate');
  await page.getByRole('button',{name:'Quay lại',exact:true}).click();
  await expect(dialog(page)).toHaveAccessibleName('Bắt đầu từ ý tưởng thật');
  expect(await page.evaluate(()=>localStorage.getItem('writer:onboarding:v1'))).toBeNull();
  if(dismissal==='finish'){
   await page.getByRole('button',{name:'Tiếp',exact:true}).click();
   await page.getByRole('button',{name:'Tiếp',exact:true}).click();
   await expect(dialog(page)).toHaveAccessibleName('Khám phá và tìm lại nội dung');
   await page.getByRole('button',{name:'Bắt đầu',exact:true}).click();
  }else if(dismissal==='escape')await page.keyboard.press('Escape');
  else await page.getByRole('button',{name:dismissal==='skip'?'Bỏ qua':'Đóng hướng dẫn',exact:true}).click();
  await expect(dialog(page)).not.toBeVisible();
  await expect(guide(page)).toBeFocused();
  expect(await page.evaluate(()=>localStorage.getItem('writer:onboarding:v1'))).toBe('seen');
  await page.reload();
  await expect(guide(page)).toBeVisible();
  await expect(dialog(page)).not.toBeVisible();
  await page.locator('#eb-input').fill('Keep my unfinished idea');
  await guide(page).click();
  await expect(dialog(page)).toHaveAccessibleName('Bắt đầu từ ý tưởng thật');
  for(let i=0;i<10;i++){
   await page.keyboard.press(i<5?'Tab':'Shift+Tab');
   expect(await dialog(page).evaluate(node=>node.contains(document.activeElement))).toBe(true);
  }
  const bounds=await dialog(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x+bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
  expect(bounds.y+bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
  await page.keyboard.press('Escape');
  await expect(guide(page)).toBeFocused();
  await expect(page.locator('#eb-input')).toHaveValue('Keep my unfinished idea');
  expect(writes).toEqual([]);
 });
}

test('blocked onboarding storage allows dismissal and reopening under StrictMode',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const writes=await openApp(page,{storageFailure:true});
 await expect(dialog(page)).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(dialog(page)).not.toBeVisible();
 await expect(guide(page)).toBeFocused();
 await page.locator('#eb-input').fill('Storage fallback input');
 await guide(page).click();
 await page.getByRole('button',{name:'Bỏ qua',exact:true}).click();
 await expect(page.locator('#eb-input')).toHaveValue('Storage fallback input');
 await expect(dialog(page)).not.toBeVisible();
 expect(errors).toEqual([]);expect(writes).toEqual([]);
});

test('existing marker suppresses first opening and English guide can be completed',async({page})=>{
 const writes=await openApp(page,{seen:true,english:true});
 await expect(page.getByRole('button',{name:'Guide',exact:true})).toBeVisible();
 await expect(dialog(page)).not.toBeVisible();
 await page.getByRole('button',{name:'Guide',exact:true}).click();
 await expect(dialog(page)).toHaveAccessibleName('Start with a real idea');
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByRole('button',{name:'Next',exact:true}).click();
 await page.getByRole('button',{name:'Get started',exact:true}).click();
 await expect(page.getByRole('button',{name:'Guide',exact:true})).toBeFocused();
 expect(writes).toEqual([]);
});
