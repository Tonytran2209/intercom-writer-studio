import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {syncBaselineSpecs} from './sync-baseline-specs.mjs';
function fixture(){
 const dir=mkdtempSync(path.join(os.tmpdir(),'baseline-ci-')),root=path.join(dir,'source'),tools=path.join(dir,'tools');mkdirSync(root);const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','test@example.test');git('config','user.name','CI test');
 const write=(file,text)=>{mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),text);};
 const commit=message=>{git('add','.');git('commit','-qm',message);return git('rev-parse','HEAD');};
 write('tests/agent-lab/sidebar-scroll.spec.mjs','old locator\n');write('tests/agent-lab/feature.spec.mjs','original feature test\n');write('tests/agent-lab/removed.spec.mjs','original removed test\n');write('tests/agent-lab/fixture.jsx','original fixture\n');write('src/App.tsx','original app\n');const ancestor=commit('common base');
 write('tests/agent-lab/sidebar-scroll.spec.mjs','correct popup locator\n');write('tests/agent-lab/feature.spec.mjs','maintainer feature test\n');write('tests/agent-lab/fixture.jsx','maintainer fixture\n');write('src/App.tsx','maintainer app\n');write('tests/agent-lab/new-baseline.spec.mjs','new baseline needs its new fixture\n');const base=commit('trusted maintenance');
 execFileSync('git',['clone','-q','--no-local',root,tools]);git('checkout','-q','--detach',ancestor);write('tests/agent-lab/feature.spec.mjs','request feature regression\n');write('tests/agent-lab/request.spec.mjs','new request regression\n');rmSync(path.join(root,'tests/agent-lab/removed.spec.mjs'));write('src/App.tsx','request app\n');const source=commit('approved request');
 return{dir,root,tools,git,write,base,source,read:p=>readFileSync(path.join(root,p),'utf8'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('refreshes only unchanged existing specs from the exact pinned base, preserving request tests, deletions, fixtures and app',()=>{
 const f=fixture();try{const manifest=syncBaselineSpecs(f.root,f.tools,f.base);assert.deepEqual(manifest.files.map(v=>v.file),['tests/agent-lab/sidebar-scroll.spec.mjs']);assert.equal(manifest.commit,f.source);assert.equal(manifest.baselineCommit,f.base);assert.equal(f.read('tests/agent-lab/sidebar-scroll.spec.mjs'),'correct popup locator\n');assert.equal(f.read('tests/agent-lab/feature.spec.mjs'),'request feature regression\n');assert.equal(f.read('tests/agent-lab/request.spec.mjs'),'new request regression\n');assert.equal(f.read('tests/agent-lab/fixture.jsx'),'original fixture\n');assert.equal(f.read('src/App.tsx'),'request app\n');assert.throws(()=>f.read('tests/agent-lab/removed.spec.mjs'));assert.throws(()=>f.read('tests/agent-lab/new-baseline.spec.mjs'));assert.equal(f.git('rev-parse','HEAD'),f.source);assert.deepEqual(JSON.parse(f.read('.lab-ci-baseline.json')),manifest);}finally{f.close();}
});
test('rejects unpinned/mismatched baseline and leaves source intact',()=>{const f=fixture();try{for(const bad of [undefined,'main','../main','a'.repeat(40)])assert.throws(()=>syncBaselineSpecs(f.root,f.tools,bad));assert.equal(f.read('tests/agent-lab/sidebar-scroll.spec.mjs'),'old locator\n');}finally{f.close();}});
test('same-head runs have no maintenance overlay or fabricated source commit',()=>{const f=fixture();try{f.git('checkout','-q','--detach',f.base);const manifest=syncBaselineSpecs(f.root,f.tools,f.base);assert.deepEqual(manifest.files,[]);assert.equal(manifest.commit,f.base);}finally{f.close();}});
