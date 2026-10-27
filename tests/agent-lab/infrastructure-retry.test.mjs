import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const yaml=readFileSync(new URL('../../.github/workflows/browser-infrastructure-retry.yml',import.meta.url),'utf8');
const script=yaml.split('          script: |\n')[1].split('\n').map(line=>line.slice(12)).join('\n');
const execute=new (Object.getPrototypeOf(async function(){}).constructor)('context','github','core',script);
const sha='a'.repeat(40);
const writer={name:'writer-check',conclusion:'success'};
const shard={name:'browser-tests (desktop)',status:'completed',head_sha:sha,conclusion:'failure',steps:[{name:'Initialize containers',conclusion:'failure'},{name:'Run browser tests',conclusion:'skipped'}]};
async function attempt({jobs=[writer,shard,{name:'browser-check',conclusion:'failure'}],number=1,repository='o/r',latest={}}={}){
 const calls=[];const run={id:42,head_sha:sha,run_attempt:number,head_repository:{full_name:repository},status:'completed',conclusion:'failure'};
 const github={rest:{actions:{getWorkflowRun:async()=>({data:{...run,...latest}}),listJobsForWorkflowRun:()=>{},reRunWorkflowFailedJobs:async args=>calls.push(args)}},paginate:async()=>jobs};
 const summary={addHeading(){return this;},addRaw(){return this;},async write(){}};
 await execute({payload:{workflow_run:run},repo:{owner:'o',repo:'r'}},github,{summary,warning(){}});return calls;
}
test('reruns a failed environment job and aggregate, retaining successful shards',async()=>{
 const calls=await attempt({jobs:[writer,shard,{...shard,name:'browser-tests (mobile)',conclusion:'success'}, {name:'browser-check',conclusion:'failure'}]});assert.deepEqual(calls,[{owner:'o',repo:'r',run_id:42}]);
});
test('does not retry assertions, unknown failures, code failures, stale or foreign runs',async()=>{
 for(const options of [
  {number:2},{repository:'fork/r'},{latest:{run_attempt:2}},{latest:{status:'in_progress'}},{latest:{head_sha:'b'.repeat(40)}},
  {jobs:[writer,{...shard,steps:[{name:'Run browser tests',conclusion:'failure'}]}]},
  {jobs:[writer,{...shard,steps:[]}]},
  {jobs:[{...writer,conclusion:'failure'},shard]},
  {jobs:[writer,{...shard,head_sha:'b'.repeat(40)}]},
  {jobs:[writer,{name:'browser-check',conclusion:'failure'}]},
  {jobs:[writer,shard,{name:'security-check',conclusion:'failure'}]},
 ])assert.deepEqual(await attempt(options),[],JSON.stringify(options));
});
