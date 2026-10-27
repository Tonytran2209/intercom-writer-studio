import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function validateEvidence(packets,commit){
 const projects=new Set(),ids=new Set(),rows=[];
 if(packets.length!==2)throw Error('Expected exactly two browser evidence packets');
 for(const packet of packets){
  if(packet.protocol!=='lab-test-v1'||packet.commit!==commit||!Array.isArray(packet.tests)||!packet.tests.length||packet.expected!==packet.tests.length)throw Error('Missing or stale browser evidence');
  const project=packet.tests[0].project;
  if(!['desktop','mobile'].includes(project)||projects.has(project))throw Error('Duplicate or unknown browser project');
  projects.add(project);
  for(const row of packet.tests){
   if(row.protocol!=='lab-test-v1'||row.commit!==commit||row.project!==project||row.status!=='passed'||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.title!=='string'||!row.title||typeof row.file!=='string'||!/^tests\/(?:agent-lab|browser)\/[A-Za-z0-9_./-]+\.spec\.[cm]?[jt]sx?$/.test(row.file)||row.file.split('/').includes('..'))throw Error('Invalid, duplicate or failed browser evidence');
   ids.add(row.id);rows.push(row);
  }
 }
 return rows;
}
function collect(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(join(dir,e.name)):e.name==='lab-evidence.json'?[JSON.parse(readFileSync(join(dir,e.name),'utf8'))]:[]);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.env.SHARDS_RESULT!=='success')throw Error('Browser shards did not all succeed');
 const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 for(const row of validateEvidence(collect(process.argv[2]),commit))console.log('LAB_TEST_V1 '+JSON.stringify(row));
}
