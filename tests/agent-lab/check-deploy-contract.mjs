import {readFileSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function checkDeploymentContract(read=p=>JSON.parse(readFileSync(p,'utf8')),exists=existsSync){
 const pkg=read('package.json');
 if(!/^npm@\d+\.\d+\.\d+$/.test(pkg.packageManager||''))throw Error('CI contract: deployment must pin npm in package.json');
 if(['pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'].some(exists))throw Error('CI contract: competing package-manager lockfile would diverge from npm CI');
 for(const prefix of ['', 'backend/']){
  const manifest=read(prefix+'package.json'),lock=read(prefix+'package-lock.json');
  for(const key of ['dependencies','devDependencies','optionalDependencies']){
   const a=manifest[key]||{},b=lock.packages?.['']?.[key]||{};
   if(Object.keys(a).length!==Object.keys(b).length||Object.keys(a).some(k=>a[k]!==b[k]))throw Error('CI contract: '+prefix+'package-lock.json is out of date');
  }
 }
 const plan=read('railpack.json');
 if(JSON.stringify(plan.steps?.install?.commands)!==JSON.stringify(['npm ci','npm ci --prefix backend'])||plan.deploy?.startCommand!=='bash start.sh'||pkg.scripts?.start!=='bash start.sh')throw Error('CI contract: Railway install/start diverges from the npm backend contract');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){checkDeploymentContract();console.log('Deployment contract verified: frozen npm installs for frontend and backend.');}
