import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshBatch } from '../src/queue/refresh-batch.js';
import { CollectionCancellationError } from '../src/core/collection-cancellation.js';
import { boundedCollection, workerDeployment } from '../src/queue/deployment.js';

test('one failing source does not starve the remaining refresh sources',async()=>{
 const called:string[]=[],failed:string[]=[];
 const result=await refreshBatch([['slow',20],['healthy',10]],async source=>{called.push(source);if(source==='slow')throw new CollectionCancellationError('deadline');return {}},source=>{failed.push(source)});
 assert.deepEqual(called,['slow','healthy']);assert.deepEqual(result.completed,['healthy']);assert.deepEqual(result.failed,['slow']);assert.deepEqual(failed,['slow']);
});
test('shutdown and lock loss stop refresh without continuing persistence',async()=>{
 for(const kind of ['shutdown','lock_lost'] as const){const called:string[]=[];await assert.rejects(refreshBatch([['first',1],['second',1]],async source=>{called.push(source);throw new CollectionCancellationError(kind)},()=>{}),e=>e instanceof CollectionCancellationError&&e.kind===kind);assert.deepEqual(called,['first'])}
});
test('external cancellation between sources is honored',async()=>{
 const controller=new AbortController(),called:string[]=[];
 await assert.rejects(refreshBatch([['first',1],['second',1]],async source=>{called.push(source);controller.abort(new CollectionCancellationError('shutdown'))},()=>{},controller.signal));assert.deepEqual(called,['first']);
});
test('source budgets preserve global limits and constrain slow collectors',()=>{
 const env={WORKER_SOURCE_LIMITS:'{"freitas":25,"api":500}',WORKER_SOURCE_TIMEOUTS_MS:'{"freitas":300000}',WORKER_HTML_LIMIT:'100',WORKER_API_LIMIT:'400'};
 const settings=workerDeployment(env);assert.deepEqual(boundedCollection(settings,'freitas','html',1200),{limit:25,timeoutMs:300000});assert.deepEqual(boundedCollection(settings,'api','api',1000),{limit:400,timeoutMs:180000});assert.equal(boundedCollection(settings,'other','html',1200).limit,100);
 for(const value of ['[]','null','{"x":0}','{"x":"25"}','{"x":15001}'])assert.throws(()=>workerDeployment({WORKER_SOURCE_LIMITS:value}));assert.throws(()=>workerDeployment({WORKER_SOURCE_TIMEOUTS_MS:'{"x":600001}'}));
});
