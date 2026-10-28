const fs=require('node:fs');
const commit=require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
class LabEvidenceReporter {
 onBegin(config,suite){this.rows=new Map();this.expected=suite.allTests().length;this.baseline=fs.existsSync('.lab-ci-baseline.json')?JSON.parse(fs.readFileSync('.lab-ci-baseline.json','utf8')):null;}
 onTestEnd(test,result){
  const project=test.parent.project()?.name;
  const row={protocol:'lab-test-v1',commit,id:test.id,file:test.location.file.replaceAll('\\','/').replace(/^.*\/(tests\/)/,'$1'),project,title:test.titlePath().join(' > ').slice(0,2000),status:result.status,retry:result.retry};
  const spec=this.baseline?.files?.find(v=>v.file===row.file);if(spec){row.baselineCommit=this.baseline.baselineCommit;row.baselineBlob=spec.baselineBlob;}
  this.rows.set(test.id,row);
 }
 onEnd(){
  const rows=[...this.rows.values()];fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/lab-evidence.json',JSON.stringify({protocol:'lab-test-v1',commit,expected:this.expected,tests:rows}));
  for(const row of rows)console.log('LAB_TEST_V1 '+JSON.stringify(row));
 }
}
module.exports=LabEvidenceReporter;
