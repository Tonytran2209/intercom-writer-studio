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

// Synthetic offline coverage for guide copy and its existing read-only contract.
for(const english of [false,true]){
 test(`workflow guide content in ${english?'English':'Vietnamese'}`,async({page})=>{
  const writes=await openApp(page,{english});
  const next=()=>page.getByRole('button',{name:english?'Next':'Tiếp',exact:true}).click();
  await expect(dialog(page).getByRole('listitem')).toHaveCount(4);
  for(const text of [english?'AI workflow':'Workflow AI',english?'EB knowledge & rules':'EB Knowledge & Rules','EB Library','EB Workflow Rules','Website Inventory','New activity','Quét dẫn chứng','Dùng dẫn chứng','Analyze']){
   await expect(dialog(page)).toContainText(text);
  }
  await next();
  await expect(dialog(page).getByRole('listitem')).toHaveCount(3);
  for(const text of ['Source & evidence','Lưu và chạy lại brief','Approve brief','Approve article','Channel output','Done','Reject','Re-check','Variant A, B']){
   await expect(dialog(page)).toContainText(text);
  }
  await next();
  await expect(dialog(page).getByRole('listitem')).toHaveCount(3);
  for(const text of ['Scan sources','Details','Verified trend','Emerging signal','Source lead','Run Gate 1','Website articles','Final review','Library Article','Search','refresh']){
   await expect(dialog(page)).toContainText(text);
  }
  expect(await page.evaluate(()=>localStorage.getItem('writer:onboarding:v1'))).toBeNull();
  await page.getByRole('button',{name:english?'Get started':'Bắt đầu',exact:true}).click();
  await expect(dialog(page)).not.toBeVisible();
  expect(writes).toEqual([]);
 });
}

for (const viewport of [{width:320,height:568},{width:390,height:844},{width:768,height:1024},{width:1024,height:768},{width:740,height:360}]) {
 test(`guide layout, hover and focus at ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);
  const writes=await openApp(page,{seen:true});
  await expect(guide(page)).toBeVisible();
  const search=page.getByRole('button',{name:'Search',exact:true});
  await expect(search).toBeVisible();
  const guideBounds=await guide(page).boundingBox();
  const searchBounds=await search.boundingBox();
  expect(Math.abs(guideBounds.y-searchBounds.y)).toBeLessThan(48);
  await search.click();
  await expect(page.getByPlaceholder('Search started packages…')).toBeVisible();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  if(viewport.width>=768){
   await page.getByRole('button',{name:'Toggle sidebar'}).click();
   await expect(guide(page)).toBeVisible();
   await expect(search).toBeVisible();
  }
  await guide(page).click();
  for(let step=0;step<3;step++){
   const primary=page.getByRole('button',{name:step===2?'Bắt đầu':'Tiếp',exact:true});
   if(step>0){
    const back=page.getByRole('button',{name:'Quay lại',exact:true});
    await back.hover();
    const backColor=await back.evaluate(node=>getComputedStyle(node).color);
    await primary.hover();
    expect(await primary.evaluate(node=>getComputedStyle(node).color)).toBe(backColor);
    expect(await primary.evaluate(node=>getComputedStyle(node).color)).not.toBe(await primary.evaluate(node=>getComputedStyle(node).backgroundColor));
   }
   const content=dialog(page).locator('.onboarding-content');
   await content.evaluate(node=>{node.scrollTop=node.scrollHeight;});
   expect(await content.evaluate(node=>Math.abs(node.scrollHeight-node.clientHeight-node.scrollTop)<=1)).toBe(true);
   const bounds=await primary.boundingBox();
   expect(bounds.y).toBeGreaterThanOrEqual(0);
   expect(bounds.y+bounds.height).toBeLessThanOrEqual(viewport.height);
   expect(await dialog(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
   if(step<2)await primary.click();
  }
  await page.setViewportSize({width:viewport.width>=768?390:1024,height:768});
  await page.keyboard.press('Escape');
  await expect(guide(page)).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(writes).toEqual([]);
 });
}


for(const viewport of [{width:1024,height:480},{width:768,height:1024},{width:390,height:568}]){
 test(`Search overlay selects a package and closes at ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);
  await page.goto('/?screen=sidebar');
  await expect(page.locator('aside.eb-sidebar').getByRole('button',{name:'Fixture package 20',exact:true,includeHidden:true})).toHaveCount(1);
  const controls=viewport.width>=768?page.locator('aside.eb-sidebar'):page.locator('nav.eb-mobile-nav');
  await controls.getByRole('button',{name:'Search',exact:true}).click();
  const input=page.getByPlaceholder('Search started packages…');
  await expect(input).toBeVisible();
  await input.fill('Fixture package 20');
  const popup=input.locator('..').locator('..');
  await expect(popup.getByRole('button',{name:'Fixture package 20',exact:true})).toHaveCount(1);
  await popup.getByRole('button',{name:'Fixture package 20',exact:true}).click();
  await expect(page.getByTestId('sidebar-action')).toHaveText('selected:sidebar-20');
  await expect(input).toHaveCount(0);
 });
}
