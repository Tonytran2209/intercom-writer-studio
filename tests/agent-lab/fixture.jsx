import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Step4Draft from '../../src/components/workspace/Step4Draft';
import {LanguageProvider} from '../../src/lib/i18n';
import {DEFAULT_CONFIG,DEFAULT_MODELS} from '../../src/lib/defaultData';
import '../../src/index.css';
import '../../src/codex-theme.css';
import EbWorkingSpace from '../../src/components/EbWorkingSpace';
const original='# CI fixture\n\nIntroduction — source remains unchanged.\n\n## Main body\nBODY_SENTINEL: Keep this section.\n\n## Conclusion\nCONCLUSION_SENTINEL: Keep this conclusion.';
function Fixture(){
 const [article,setArticle]=useState({id:'ci-fixture',topic:'CI fixture',draft:original,keywords:'fixture',tone:'professional',outline:[],currentStep:4,status:'draft'});
 return <main><details open><summary>Fixture source</summary><pre data-testid="stored-source">{article.draft}</pre></details><Step4Draft article={article} config={DEFAULT_CONFIG} files={[]} model={DEFAULT_MODELS[0]} railwayUrl="" onUpdate={async p=>{setArticle(a=>({...a,...p}));return true;}} onPrev={()=>{}} onToggleComplete={()=>{}}/></main>;
}
const screen=new URLSearchParams(location.search).get('screen');
createRoot(document.getElementById('root')).render(<LanguageProvider>{screen==='eb'?<EbWorkingSpace config={DEFAULT_CONFIG}/>:<Fixture/>}</LanguageProvider>);
