const fs=require('node:fs');
const commit=require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
class LabEvidenceReporter {
 onBegin(){this.rows=new Map();}
 onTestEnd(test,result){
  const project=test.parent.project()?.name;
  const row={protocol:'lab-test-v1',commit,id:test.id,file:test.location.file.replaceAll('\\','/').replace(/^.*\/(tests\/)/,'$1'),project,title:test.titlePath().join(' > ').slice(0,2000),status:result.status,retry:result.retry};
  this.rows.set(test.id,row);
 }
 onEnd(){
  const rows=[...this.rows.values()];fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/lab-evidence.json',JSON.stringify({protocol:'lab-test-v1',commit,tests:rows}));
  for(const row of rows)console.log('LAB_TEST_V1 '+JSON.stringify(row));
 }
}
module.exports=LabEvidenceReporter;
