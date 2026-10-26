import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvidence} from './merge-evidence.mjs';
const packets=()=>['desktop','mobile'].map(project=>({protocol:'lab-test-v1',commit:'abc',expected:1,tests:[{protocol:'lab-test-v1',commit:'abc',project,id:project,title:'test',file:'tests/agent-lab/draft.spec.mjs',status:'passed'}]}));
test('preserves successful exact-commit evidence from both browser projects',()=>assert.equal(validateEvidence(packets(),'abc').length,2));
for(const [name,mutate] of Object.entries({missing:p=>p.pop(),stale:p=>p[1].commit='old',skipped:p=>p[1].tests[0].status='skipped',failed:p=>p[1].tests[0].status='failed',duplicate:p=>p[1].tests[0].project='desktop',incomplete:p=>p[1].expected=2,wrongRow:p=>p[1].tests[0].commit='old'}))test(`rejects ${name} evidence`,()=>{const p=packets();mutate(p);assert.throws(()=>validateEvidence(p,'abc'));});
