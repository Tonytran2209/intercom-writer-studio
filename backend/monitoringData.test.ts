import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readMonitoringData} from './monitoringData.ts';
test('EB V2 counts latest revisions and keeps final-attempt ledger coverage and unknown cost explicit',async()=>{
 const db=new PGlite();const previous=process.env.DATABASE_PROVIDER;process.env.DATABASE_PROVIDER='postgres';
 try{
 await db.exec(`CREATE TABLE kv_store(key text primary key,value jsonb);
 CREATE TABLE eb_v2_articles(package_id text,revision int,status text);
 CREATE TABLE eb_v2_packages(state text);
 CREATE TABLE eb_v2_channel_outputs(package_id text,channel text,revision int,status text);
 CREATE TABLE eb_v2_gate_runs(id text DEFAULT 'test-run',package_id text DEFAULT 'test-package',model_provider text,model_id text,gate text,stage text,status text,input_tokens int,cached_input_tokens int,output_tokens int,cost_usd numeric,created_at timestamptz);
 INSERT INTO eb_v2_articles VALUES ('one',1,'superseded'),('one',2,'approved'),('two',1,'draft');
 INSERT INTO eb_v2_packages VALUES ('completed'),('review');
 INSERT INTO eb_v2_channel_outputs VALUES ('one','facebook',1,'rejected'),('one','facebook',2,'done'),('one','threads',1,'queued');
 INSERT INTO eb_v2_gate_runs(model_provider,model_id,gate,stage,status,input_tokens,cached_input_tokens,output_tokens,cost_usd,created_at) VALUES ('test','model','article','draft','completed',100,20,10,null,now()),('test','model','article','draft','failed',0,0,0,null,now());`);
 const client={query:async(sql:string,values?:any[])=>db.query(sql,values),release:()=>{}};
 const result=await readMonitoringData('2020-01-01T00:00:00.000Z',{connect:async()=>client,totalCount:1,idleCount:0,waitingCount:0} as any);
 assert.equal(result.articles.total,2);
 assert.equal(result.articles.byStatus.find((r:any)=>r.status==='EB V2 · approved').count,1);
 assert.equal(result.inventory!.eb_v2_channel_outputs.reduce((n:number,r:any)=>n+r.count,0),2);
 assert.ok(!result.inventory!.eb_v2_channel_outputs.some((r:any)=>r.status.includes('rejected')));
 const row=result.ledger.models[0];assert.equal(row.records,2);assert.equal(row.calls,1);assert.equal(row.input_tokens,100);assert.equal(row.known_cost_usd,null);assert.equal(row.priced_calls,0);assert.equal(row.source,'eb-v2');
 const [hour]=result.ledger.timeline;
 assert.equal(hour.calls,1);
 assert.equal(hour.totalTokens,110);
 assert.equal(hour.knownCostUsd,null);
 assert.equal(result.inventory!.eb_v2_feedback_threads,null);
 assert.equal(result.ledger.scope.includes('not every provider retry'),true);
 }finally{if(previous===undefined)delete process.env.DATABASE_PROVIDER;else process.env.DATABASE_PROVIDER=previous;await db.close();}
});
