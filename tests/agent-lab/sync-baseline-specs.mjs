import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const specPath=p=>/^tests\/agent-lab\/[A-Za-z0-9_/-]+\.spec\.mjs$/.test(p)&&!p.split('/').includes('..');
const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:2000000}).trimEnd();
// Baseline specs are trusted CI tools. Only refresh an existing spec left unchanged
// by the request; never replace its changed/new tests, fixtures or application code.
export function syncBaselineSpecs(root,tools,expectedBase){
 if(!/^[a-f0-9]{40}$/.test(expectedBase||''))throw Error('Invalid pinned CI baseline SHA');
 const base=git(tools,['rev-parse','HEAD']);
 if(base!==expectedBase)throw Error('Pinned CI baseline does not match tools checkout');
 const source=git(root,['rev-parse','HEAD']),ancestor=git(root,['merge-base',source,base]);
 const tree=(cwd,ref)=>git(cwd,['ls-tree','-r','--name-only',ref,'--','tests/agent-lab']).split('\n').filter(specPath);
 const headPaths=new Set(tree(root,source)),ancestorPaths=new Set(tree(root,ancestor));
 const changed=new Set(git(root,['diff','--name-only','--no-renames',ancestor,source,'--','tests/agent-lab']).split('\n'));
 const files=[];
 for(const file of tree(tools,base)){
  if(!headPaths.has(file)||!ancestorPaths.has(file)||changed.has(file))continue;
  const original=git(root,['rev-parse',source+':'+file]),trusted=git(tools,['rev-parse',base+':'+file]);
  if(original===trusted)continue;
  const content=execFileSync('git',['-C',tools,'show',base+':'+file],{maxBuffer:1000000});
  mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),content);
  files.push({file,originalBlob:original,baselineBlob:trusted});
 }
 const manifest={protocol:'lab-ci-baseline-v1',commit:source,baselineCommit:base,ancestor,files};
 writeFileSync(path.join(root,'.lab-ci-baseline.json'),JSON.stringify(manifest));
 return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const manifest=syncBaselineSpecs(process.cwd(),path.resolve('.lab-ci-tools'),process.env.CI_BASE_SHA);
 console.log('LAB_CI_BASELINE_V1 '+JSON.stringify(manifest));
}
