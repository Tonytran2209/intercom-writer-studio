import {test,expect} from '@playwright/test';
// Synthetic fixtures exercise the real UI; no production image/sample is asserted.
const image={name:'source.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64')};
for(const target of ['input','popup','discovery']) test(target+': review, edit, apply, error retry and stale image response',async({page})=>{
 const data={packages:[{id:'image-package',title:'Image evidence fixture',state:'brief'}],runs:[],articles:[],channels:[],discovery:[{id:'idea-image',status:'suggested',title:'Discovery fixture',source_summary:'Synthetic source lead',evidence_status:'source_lead'}]};
 let calls=0;let release;let fail=true;let hold=false;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/workspace'))return route.fulfill({json:data});
  // Preparation loads source details separately from the workspace snapshot.
  if(path==='/api/eb-v2/discovery/idea-image/details')return route.fulfill({json:{item:data.discovery[0],sources:[]}});
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
  await expect(page.locator('.eb-input-engine').getByText('Suggestion chưa lưu ID nguồn trích dẫn.',{exact:true})).toBeVisible();
 }
 let scope=page.locator('.eb-input-engine');
 if(target==='popup'){
  await page.getByRole('button',{name:'Open task: Image evidence fixture',exact:true}).click();
  scope=page.locator('aside');
 }
 async function drop(files){
  await scope.evaluate((element,files)=>{
   const transfer=new DataTransfer();
   for(const file of files)transfer.items.add(new File([new Uint8Array(file.size??1)],file.name,{type:file.type}));
   for(const type of ['dragenter','dragover','drop'])element.querySelector('#eb-input').dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer}));
  },files);
 }
 if(target!=='popup'){
  await expect(scope.getByText('Nêu rõ liên hệ với F/sự kiện của F và nguồn xác nhận trong cùng nội dung.',{exact:true})).toHaveCount(0);
  await expect(scope.getByText('Chọn icon ảnh hoặc kéo thả một ảnh PNG/JPEG/WebP · tối đa 15 MiB.',{exact:true})).toHaveCount(0);
  await expect(scope.getByRole('status')).toHaveCount(0);
  await scope.locator('#eb-input').dispatchEvent('dragenter',{dataTransfer:await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'drag.png',{type:'image/png'}));return transfer;})});
  await expect(scope.getByRole('status')).toHaveText('Thả một ảnh dẫn chứng tại đây');
  await scope.locator('#eb-input').dispatchEvent('dragleave',{dataTransfer:await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'drag.png',{type:'image/png'}));return transfer;})});
  await expect(scope.getByRole('status')).toHaveCount(0);
  const trigger=scope.getByRole('button',{name:'Chọn ảnh dẫn chứng',exact:true});
  await expect(trigger).toHaveAttribute('title',/PNG/);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await expect(scope.getByRole('button',{name:'Quét dẫn chứng',exact:true})).toHaveCount(0);
  await drop([{name:'invalid.txt',type:'text/plain'}]);
  await expect(scope.getByRole('alert')).toContainText('15 MiB');
  await drop([{name:'large.png',type:'image/png',size:15*1024*1024+1}]);
  await expect(scope.getByRole('alert')).toContainText('15 MiB');
  await drop([{name:'one.png',type:'image/png'},{name:'two.png',type:'image/png'}]);
  await expect(scope.getByRole('alert')).toContainText('một ảnh');
  expect(calls).toBe(0);
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
 if(target==='popup')await upload.setInputFiles({...image,name:'replacement.png'});
 else await drop([{name:'replacement.png',type:'image/png'}]);
 release();
 await expect(draft).toHaveCount(0);
 await expect(destination).toHaveValue(/Human confirmed source/);
});
