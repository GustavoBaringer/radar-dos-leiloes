import assert from 'node:assert/strict';
import test from 'node:test';
import {workerDeployment,createCollectionGate} from '../src/queue/deployment.js';

test('deployment rejects configurations that exceed resource bounds',()=>{
 for(const env of [{WORKER_COLLECT_CONCURRENCY:'3'},{WORKER_JOB_TIMEOUT_MS:'0'},
 {WORKER_API_LIMIT:'15001'},{WORKER_DISCOVERY_CONCURRENCY:'NaN'},
 {WORKER_CLOSE_ENABLED:'yes'},{WORKER_TIMEZONE:'invalid/zone'}]) assert.throws(()=>workerDeployment(env));
});
test('Brazil deployment has explicit timezone and bounded parallelism',()=>{
 const settings=workerDeployment({WORKER_TIMEZONE:'America/Sao_Paulo',WORKER_COLLECT_CONCURRENCY:'1',WORKER_SERIAL_COLLECTIONS:'1'});
 assert.equal(settings.timezone,'America/Sao_Paulo');assert.equal(settings.concurrency,1);assert.equal(settings.serial,true);
});
test('collect and refresh share one resource slot, and a failure releases it',async()=>{
 const gate=createCollectionGate();let active=0,max=0;const events:string[]=[];
 const op=(name:string,fail=false)=>gate(async()=>{active++;max=Math.max(max,active);events.push(name+' start');await new Promise(r=>setTimeout(r,5));active--;events.push(name+' end');if(fail)throw Error('controlled');return name});
 const results=await Promise.allSettled([op('collect',true),op('refresh'),op('collect2')]);
 assert.equal(max,1);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(results[2].status,'fulfilled');
 assert.deepEqual(events,['collect start','collect end','refresh start','refresh end','collect2 start','collect2 end']);
});
