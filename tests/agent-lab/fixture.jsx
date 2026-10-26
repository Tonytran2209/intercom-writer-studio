import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Step4Draft from '../../src/components/workspace/Step4Draft';
import {LanguageProvider} from '../../src/lib/i18n';
import {DEFAULT_CONFIG,DEFAULT_MODELS} from '../../src/lib/defaultData';
import '../../src/index.css';
import '../../src/codex-theme.css';
import EbWorkingSpace from '../../src/components/EbWorkingSpace';
import EbSidebar from '../../src/components/EbSidebar';
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
const screen=new URLSearchParams(location.search).get('screen');
createRoot(document.getElementById('root')).render(<LanguageProvider>{screen==='sidebar'?<SidebarFixture/>:screen==='eb'?<EbWorkingSpace config={DEFAULT_CONFIG}/>:<Fixture/>}</LanguageProvider>);
