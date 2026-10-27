import {test,expect} from '@playwright/test';
// Synthetic fixtures exercise the real UI; no production image/sample is asserted.
const image={name:'source.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64')};
for(const target of ['input','popup','discovery']) test(target+': review, edit, apply, error retry and stale image response',async({page})=>{
 const data={packages:[{id:'image-package',title:'Image evidence fixture',state:'brief'}],runs:[],articles:[],channels:[],discovery:[{id:'idea-image',status:'suggested',title:'Discovery fixture',source_summary:'Synthetic source lead',evidence_status:'source_lead'}]};
 let calls=0;let release;let fail=true;let hold=false;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/workspace'))return route.fulfill({json:data});
  if(path.includes('/activity/'))return route.fulfill({json:{inputs:[],runs:[],articles:[],channels:[],feedback:[],actions:[]}});
  if(path.endsWith('/evidence/scan')){
   calls++;
   expect(route.request().postDataBuffer().toString()).toContain('source.png');
   if(hold)await new Promise(resolve=>{release=resolve;});
   return route.fulfill(fail?{status:422,json:{error:'Synthetic scan error'}}:{json:{evidence:'Visible source fixture'}});
  }
  return route.abort();
 });
 await page.goto('/?screen=eb');
 await page.evaluate(async()=>{
  const {DEFAULT_CONFIG,DEFAULT_MODELS}=await import('/src/lib/defaultData.ts');
  DEFAULT_CONFIG.models=[{...DEFAULT_MODELS[0],id:'vision-fixture',enabled:true}];
 });
 await page.getByRole('button',{name:'Refresh V2 workspace',exact:true}).click();
 await expect(page.getByRole('button',{name:'Refresh V2 workspace',exact:true})).toBeEnabled();
 if(target==='discovery'){
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('writer:eb-open',{detail:'discovery'})));
  await page.getByRole('button',{name:'Bổ sung thông tin cho Gate 1',exact:true}).click();
 }
 let scope=page.locator('.eb-input-engine');
 if(target==='popup'){
  await page.getByRole('button',{name:'Open task: Image evidence fixture',exact:true}).click();
  scope=page.locator('aside');
 }
 const upload=scope.getByLabel('Ảnh dẫn chứng',{exact:true});
 await upload.setInputFiles(image);
 await scope.getByRole('button',{name:'Quét dẫn chứng',exact:true}).click();
 await expect(scope.getByRole('alert')).toContainText('Synthetic scan error');
 fail=false;
 await scope.getByRole('button',{name:'Quét dẫn chứng',exact:true}).click();
 const draft=scope.getByRole('textbox',{name:'Dẫn chứng từ ảnh',exact:true});
 await expect(draft).toHaveValue('Visible source fixture');
 await draft.fill('Human confirmed source');
 await scope.getByRole('button',{name:'Dùng dẫn chứng',exact:true}).click();
 const destination=target==='discovery'?scope.getByRole('textbox',{name:'Nguồn xác nhận liên hệ F (link hoặc dẫn chứng cụ thể)',exact:true}):target==='input'?scope.getByRole('textbox',{name:'Nội dung topic, mối liên hệ với F và nguồn xác nhận'}):scope.getByRole('textbox',{name:'Dẫn chứng / nguồn xác nhận tại F',exact:true});
 await expect(destination).toHaveValue(/Human confirmed source/);
 hold=true;
 await scope.getByRole('button',{name:'Quét dẫn chứng',exact:true}).click();
 await expect.poll(()=>calls).toBe(3);
 await upload.setInputFiles({...image,name:'replacement.png'});
 release();
 await expect(draft).toHaveCount(0);
 await expect(destination).toHaveValue(/Human confirmed source/);
});
