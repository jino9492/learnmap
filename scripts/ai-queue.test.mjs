import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageRequestQueue, scopedAiClient, usageTokens, queueLimitsFromEnv } from '../apps/api/src/ai/core/queue.ts';
import { createJsonClient } from '../apps/api/src/ai/core/http.ts';
import { analysisProgress } from '../apps/api/src/features/material-analysis/progress.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const makeQueue = (t, limits = {}) => {
  const queue = new UsageRequestQueue({tokens: 1000, requests: 100, concurrency: 1, windowMs: 1000, ...limits});
  t.after(() => queue.close()); return queue;
};
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

test('interactive requests overtake queued graph requests; FIFO within a priority', async t => {
  const q = makeQueue(t); const first = await q.acquire(10, 'concept_extraction'); const order = [];
  const low = q.acquire(10, 'relation_analysis').then(lease => {order.push('graph'); lease.finish(10);});
  const high = q.acquire(10, 'question_generation').then(lease => {order.push('question'); lease.finish(10);});
  const high2 = q.acquire(10, 'answer_evaluation').then(lease => {order.push('answer'); lease.finish(10);});
  first.finish(10); await Promise.all([low, high, high2]);
  assert.deepEqual(order, ['question', 'answer', 'graph']);
});
test('aging prevents graph starvation', async t => {
  t.mock.timers.enable({apis:['Date', 'setTimeout']});
  const q = makeQueue(t); const first = await q.acquire(10, 'test'); const order = [];
  const low = q.acquire(10, 'relation_analysis').then(lease => {order.push('graph'); lease.finish(1);});
  t.mock.timers.tick(30001);
  const high = q.acquire(10, 'question_generation').then(lease => {order.push('question'); lease.finish(1);});
  first.finish(1); await Promise.all([low, high]); assert.deepEqual(order, ['graph','question']);
});
test('reservations prevent oversubscription and actual usage releases capacity', async t => {
  const q = makeQueue(t, {tokens:100, concurrency:4});
  const first = await q.acquire(80, 'test'); let running = false;
  const next = q.acquire(30, 'test').then(lease => {running = true; return lease;});
  await flush(); assert.equal(running,false); assert.equal(q.snapshot().reservedTokens,80);
  first.finish(20); (await next).finish(30);
  assert.equal(q.snapshot().usedTokens,50); assert.equal(q.snapshot().reservedTokens,0);
});
test('budget blocks even high priority until rolling window expires', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const q = makeQueue(t,{tokens:100}); (await q.acquire(100,'test')).finish(100);
  let started = false; const next = q.acquire(10,'question_generation').then(lease => {started=true; lease.finish(10);});
  t.mock.timers.tick(999); await Promise.resolve(); assert.equal(started,false);
  t.mock.timers.tick(1); await next; assert.equal(started,true);
});
test('request count cap also blocks zero-token responses', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const q = makeQueue(t,{requests:1}); (await q.acquire(10,'test')).finish(0);
  let started = false; const next = q.acquire(10,'test').then(lease => {started=true; lease.finish(0);});
  await Promise.resolve(); assert.equal(started,false); t.mock.timers.tick(1000); await next;
});
test('parallelism drops with usage; expired queued work never starts', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout']});
  const q = makeQueue(t,{concurrency:4, tokens:100}); (await q.acquire(80,'test')).finish(80);
  assert.equal(q.snapshot().concurrency,1);
  const held = await q.acquire(10,'test');
  const expired = assert.rejects(q.acquire(10,'test',Date.now()+10),{code:'TIMEOUT'});
  t.mock.timers.tick(10); await expired; held.finish(10); assert.equal(q.snapshot().waiting,0);
});
test('bounded queue, oversized requests, missing usage and idempotent release', async t => {
  const q=makeQueue(t,{capacity:1}); const held=await q.acquire(30,'test');
  await assert.rejects(q.acquire(10,'test'),{reason:'UNAVAILABLE'});
  held.finish(); held.finish(); assert.equal(q.snapshot().usedTokens,30);
  await assert.rejects(q.acquire(1001,'test'),{code:'INPUT'});
  (await q.acquire(10,'test')).finish(10);
});
test('helper requests inherit interactive scope and waiting UI preserves progress', async t => {
  const q=makeQueue(t); const first=await q.acquire(10,'test'); let state;
  const inner={async generate(req){const lease=await q.acquire(10,req.name); lease.finish(10); return {};}};
  const client=scopedAiClient(inner,'interactive',value=>{state=value;});
  const pending=client.generate({name:'korean_localization'});
  assert.deepEqual(state,{waiting:1,active:0});
  const job={status:'analyzing_relations',events:[{kind:'progress',stage:'relations',completed:2,total:4}],queueState:state};
  const progress=analysisProgress(job); assert.match(progress.label,/대기 중/); assert.equal(progress.percent,67);
  first.finish(10); await pending; assert.deepEqual(state,{waiting:0,active:0});
  assert.equal(analysisProgress({...job,queueState:state}).waiting,false);
});
test('usage normalization and invalid configuration', () => {
  assert.equal(usageTokens({total_tokens:20}),20);
  assert.equal(usageTokens({totalTokenCount:30}),30);
  assert.equal(usageTokens({input_tokens:10,output_tokens:5}),15);
  assert.equal(usageTokens({}),undefined);
  assert.throws(()=>queueLimitsFromEnv({AI_QUEUE_TOKENS:'0'}),{code:'CONFIG'});
});
const request={name:'concept_extraction',instructions:'',data:{},schema:{json:{},parse:v=>v}};
function client(fetcher,scheduler,options={}) {
  return createJsonClient({provider:'test',url:'https://example.invalid',headers:{},body:()=>({}),output:value=>({text:JSON.stringify(value),usage:{total_tokens:10}})},
    {fetcher,scheduler,maxAttempts:1,...options});
}
test('clients share the queue through body consumption; failed calls release their slot', async t => {
  const q=makeQueue(t,{tokens:100000}); const gate=deferred(); const entered=deferred(); const order=[];
  const first=client(async()=>{order.push(1);entered.resolve();return {ok:true,text:()=>gate.promise};},q).generate(request);
  await entered.promise;
  const second=client(async()=>{order.push(2);return Response.json({});},q).generate(request);
  await flush(); assert.deepEqual(order,[1]); gate.resolve('{}'); await Promise.all([first,second]);
  const fail=client(async()=>{throw new Error('network');},q).generate(request);
  await assert.rejects(fail,{code:'CONNECTION'}); assert.equal(q.snapshot().active,0);
});
test('every retry is charged and high priority runs before a graph retry', async t => {
  const q=makeQueue(t,{tokens:100000}); const sleeping=deferred(); const resume=deferred(); const order=[]; let calls=0;
  const first=client(async()=>{order.push('graph');return ++calls===1?new Response('{}',{status:429}):Response.json({});},q,
    {maxAttempts:2,sleep:async()=>{sleeping.resolve();await resume.promise;}}).generate(request);
  await sleeping.promise;
  const second=client(async()=>{order.push('question');return Response.json({});},q).generate({...request,name:'question_generation'});
  resume.resolve();await Promise.all([first,second]);
  assert.deepEqual(order,['graph','question','graph']);assert.equal(q.snapshot().usedRequests,3);
});
