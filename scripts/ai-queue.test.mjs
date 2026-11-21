import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageRequestQueue, scopedAiClient, createAiQueues, coolDownModel, queueLane, usageTokens, queueLimitsFromEnv } from '../apps/api/src/ai/core/queue.ts';
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
  await assert.rejects(q.acquire(10,'test'),{reason:'QUEUE_FULL'});
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
test('429 retries go to the tail, keep waiting after the deadline, and do not spend the attempt limit', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
  const q=makeQueue(t,{tokens:100000,windowMs:10000});
  const inFlight=deferred(), release=deferred(), order=[];
  let calls=0, state;
  const graph=scopedAiClient(client(async()=>{
    order.push('graph');
    if (++calls === 1) { inFlight.resolve(); await release.promise; }
    return calls<=2 ? new Response('{}',{status:429,headers:{'Retry-After':'2'}}) : Response.json({});
  },q), 'interactive', value=>{state=value;});
  const result=graph.generate({...request,deadlineAt:Date.now()+1000});
  await inFlight.promise;
  const other=client(async()=>{order.push('already queued');return Response.json({});},q).generate({...request,name:'other'});
  release.resolve(); await flush();
  assert.deepEqual(state,{active:0,waiting:1});
  t.mock.timers.tick(2000); await flush();
  assert.deepEqual(order,['graph','already queued','graph']);
  assert.deepEqual(state,{active:0,waiting:1});
  t.mock.timers.tick(2000); await Promise.all([result,other]);
  assert.deepEqual(order,['graph','already queued','graph','graph']);
  assert.equal(q.snapshot().usedRequests,4);
});

test('cancel removes a 429 retry waiting in the queue', async t => {
  const q=makeQueue(t,{tokens:100000});
  const controller=new AbortController();
  const task=scopedAiClient(client(async()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}}),q),'graph',undefined,controller.signal);
  const rejected=assert.rejects(task.generate(request),{code:'CANCELLED'});
  await flush();
  assert.equal(q.snapshot().waiting,1);
  controller.abort(); await rejected;
  assert.equal(q.snapshot().waiting,0);
});

test('measured queues isolate graph saturation, including scoped helper calls', async t => {
  const config = {AI_QUEUE_PROFILE:'learnmap-cloud',OPENAI_MODEL:'gpt-6.1-sol',OPENAI_FAST_MODEL:'gpt-6-luna'};
  const queues = createAiQueues({...config, AI_GRAPH_QUEUE_CONCURRENCY:'1', AI_GRAPH_QUEUE_CAPACITY:'1'});
  t.after(() => Object.values(queues).forEach(q => q.close()));
  assert.equal(queues.interactive.limits.concurrency,192);
  assert.equal(queues.graph.limits.tokens + queues.interactive.limits.tokens,3200000);
  assert.throws(() => createAiQueues({...config, AI_INTERACTIVE_QUEUE_TOKENS:'3200000'}),{code:'CONFIG'});
  const helper = {generate: req => queues[queueLane(req.name)].acquire(100, req.name)};
  const graph = scopedAiClient(helper,'graph');
  const interactive = scopedAiClient(helper,'interactive');
  const held = await graph.generate({name:'korean_localization'});
  await assert.rejects(graph.generate({name:'concept_extraction'}),{reason:'QUEUE_FULL'});
  (await interactive.generate({name:'korean_localization'})).finish(12);
  assert.equal(queues.graph.snapshot().usedTokens,0);
  assert.equal(queues.interactive.snapshot().usedTokens,12);
  held.finish(42);
});

test('a small request fits behind a large one and cancelled waits release admission', async t => {
  const q=makeQueue(t,{tokens:100});
  (await q.acquire(70,'test')).finish(70);
  const controller=new AbortController();
  const client=scopedAiClient({generate:()=>q.acquire(40,'test')},'interactive',undefined,controller.signal);
  const rejected=assert.rejects(client.generate({}),{code:'CANCELLED'});
  (await q.acquire(5,'question_generation')).finish(5);
  assert.equal(q.snapshot().waiting,1);
  controller.abort();
  await rejected;
  assert.equal(q.snapshot().waiting,0);
  assert.equal(q.snapshot().usedTokens,75);
});

test('paced cloud queues can fill both slot ceilings without admitting the next call', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now:1000});
  const queues = createAiQueues({ AI_QUEUE_PROFILE:'learnmap-cloud', OPENAI_MODEL:'gpt-6.1-sol', OPENAI_FAST_MODEL:'gpt-6-luna' });
  const submitted = [];
  for (const [name, q] of Object.entries(queues)) {
    for (let i = 0; i <= q.limits.concurrency; i++) submitted.push(q.acquire(6001, name).catch(() => null));
  }
  for (let tick = 0; tick < 450; tick++) t.mock.timers.tick(100);
  assert.equal(queues.graph.snapshot().active,64);
  assert.equal(queues.interactive.snapshot().active,192);
  for (const q of Object.values(queues)) {
    assert.equal(q.snapshot().waiting,1);
    assert.ok(q.snapshot().reservedTokens <= q.limits.tokens);
    q.close();
  }
  for (const lease of await Promise.all(submitted)) lease?.finish(1);
});

test('graph pacing repays unused reservations without removing the request cadence', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now:1000});
  const q = new UsageRequestQueue({windowMs:1000, tokens:100, requests:4, concurrency:4}, true, 0);
  t.after(() => q.close());
  const first = await q.acquire(60, 'relation_analysis', undefined, undefined, 20);
  const next = q.acquire(35, 'relation_analysis');
  first.finish(10);
  t.mock.timers.tick(249);
  assert.equal(q.snapshot().active,0);
  t.mock.timers.tick(1);
  (await next).finish(10);
  assert.equal(q.snapshot().usedTokens,20);
});

test('cloud graph burst doubles by default and supports a bounded override', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now:1000});
  const profile = {AI_QUEUE_PROFILE:'learnmap-cloud', OPENAI_MODEL:'gpt-6.1-sol', OPENAI_FAST_MODEL:'gpt-6-luna'};
  const baseline = createAiQueues({...profile, AI_GRAPH_QUEUE_BURST_MS:'3000'});
  const updated = createAiQueues(profile);
  for (const [queues, expected] of [[baseline,4],[updated,7]]) {
    const pending = Array.from({length:10},()=>queues.graph.acquire(20000,'relation_analysis').catch(()=>null));
    assert.equal(queues.graph.snapshot().active,expected);
    queues.graph.close(); queues.interactive.close();
    for (const lease of await Promise.all(pending)) lease?.finish();
  }
  assert.throws(()=>createAiQueues({...profile, AI_GRAPH_QUEUE_BURST_MS:'6001'}),{code:'CONFIG'});
});

test('OpenAI rate-limit recovery spaces model starts across both queues', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now:1000});
  const graph=makeQueue(t), interactive=makeQueue(t);
  const key='openai/recovery-test';
  coolDownModel(key,2000,true);
  const first=graph.acquire(10,'relation_candidates',undefined,key);
  const second=interactive.acquire(10,'question_generation',undefined,key);
  t.mock.timers.tick(1999);
  assert.equal(graph.snapshot().active + interactive.snapshot().active,0);
  t.mock.timers.tick(1);
  (await first).finish(10);
  t.mock.timers.tick(499);
  assert.equal(interactive.snapshot().active,0);
  t.mock.timers.tick(1);
  (await second).finish(10);
});

test('OpenAI organization spend limit fails on the first response without requeueing', async t => {
  const q=makeQueue(t,{tokens:100000});
  let calls=0;
  const llm=createJsonClient({provider:'openai',model:'spend-limit-test',url:'mock',headers:{},body:()=>({}),output:()=>assert.fail('No generation expected')},{
    scheduler:q,fetcher:async()=>{calls++;return Response.json({error:{code:'organization_spend_limit_exceeded'}},{status:429});},
  });
  await assert.rejects(llm.generate(request),{reason:'QUOTA_EXHAUSTED',message:/조직의 API 지출 한도/});
  assert.equal(calls,1);
  assert.equal(q.snapshot().waiting+q.snapshot().active,0);
});
