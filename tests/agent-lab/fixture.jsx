import {mountFixture} from './bootstrap';
import React,{useEffect,useState} from 'react';
import Step4Draft from '../../src/components/workspace/Step4Draft';
import {DEFAULT_CONFIG,DEFAULT_MODELS} from '../../src/lib/defaultData';
import EbWorkingSpace from '../../src/components/EbWorkingSpace';
import EbSidebar from '../../src/components/EbSidebar';
import ConfigModal from '../../src/components/config/ConfigModal';
const original='# CI fixture\n\nIntroduction — source remains unchanged.\n\n## Main body\nBODY_SENTINEL: Keep this section.\n\n## Conclusion\nCONCLUSION_SENTINEL: Keep this conclusion.';
function Fixture(){
 const [article,setArticle]=useState({id:'ci-fixture',topic:'CI fixture',draft:original,keywords:'fixture',tone:'professional',outline:[],currentStep:4,status:'draft'});
 return <main><details open><summary>Fixture source</summary><pre data-testid="stored-source">{article.draft}</pre></details><Step4Draft article={article} config={DEFAULT_CONFIG} files={[]} model={DEFAULT_MODELS[0]} railwayUrl="" onUpdate={async p=>{setArticle(a=>({...a,...p}));return true;}} onPrev={()=>{}} onToggleComplete={()=>{}}/></main>;
}
// Synthetic data exercises the 20-item event contract; it is not a production sample.
function SidebarFixture(){
 const [action,setAction]=useState('');
 useEffect(()=>{
  const selected=event=>setAction(`selected:${event.detail}`);
  window.addEventListener('writer:eb-open-item',selected);
  // Dispatch after the sidebar's effects have installed their listeners.
  const timer=setTimeout(()=>window.dispatchEvent(new CustomEvent('writer:eb-items',{detail:Array.from({length:20},(_,i)=>({id:`sidebar-${i+1}`,packageId:`package-${i+1}`,title:`Fixture package ${String(i+1).padStart(2,'0')}`,gate:'article',color:'bg-amber-500'}))})),0);
  return ()=>{clearTimeout(timer);window.removeEventListener('writer:eb-open-item',selected);};
 },[]);
 return <div className="writer-light h-dvh select-none flex flex-col gap-2 overflow-hidden bg-[#e9ecef] p-3 md:flex-row text-slate-900"><EbSidebar onOpenSettings={()=>setAction('settings')} onNewPackage={()=>setAction('new')} onOpenDiscovery={()=>setAction('discovery')}/><main className="min-h-0 min-w-0 flex-1 overflow-hidden"><output data-testid="sidebar-action">{action}</output></main></div>;
}
// Synthetic legacy files validate preservation; these are not production samples.
const settingsFiles=['action','action-plan','rules'].map(category=>({id:`fixture-${category}`,name:`fixture-${category}.txt`,category,fileType:'txt',size:'17 B',uploadedAt:'2026-01-01',content:`sentinel-${category}`}));
function SettingsFixture(){
 const [open,setOpen]=useState(true);
 const [saved,setSaved]=useState(null);
 return <><output data-testid="saved-settings">{JSON.stringify(saved)}</output>{open?<ConfigModal config={DEFAULT_CONFIG} files={settingsFiles} articles={[]} onSave={(config,files)=>setSaved({config,files})} onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>Reopen settings</button>}</>;
}
const screen=new URLSearchParams(location.search).get('screen');
mountFixture(screen==='settings'?<SettingsFixture/>:screen==='sidebar'?<SidebarFixture/>:screen==='eb'?<EbWorkingSpace config={DEFAULT_CONFIG}/>:<Fixture/>);
