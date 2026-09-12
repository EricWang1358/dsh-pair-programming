import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoBoard, mountPanelFixture, installFixtureApi } from '../scripts/panel-fixture.mjs';
import { projectPairPanel } from '../lib/runtime/panel-model.js';
import { activeSpan, panelProgress } from '../lib/runtime/panel-progress.js';
import { createPanelHandler, readPanelSnapshot, installPairPanel } from '../lib/runtime/panel-rpc.js';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { createTeamDir, writeTeam } from '../lib/state/store.js';
import { appendMailbox, createMessage } from '../lib/state/mailbox.js';
import { renderClient } from '../scripts/build-client.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export async function run(report) {
  async function check(name, fn) { try { await fn(); report(true, name); } catch (e) { report(false, name + ': ' + e.stack); } }
  await check('panel distinguishes completion, QA, board credential and integration without exposing execution capabilities', () => {
    const board = demoBoard(), panel = projectPairPanel(board, { taskId: 't-4' });
    assert.deepEqual([panel.counts.completed, panel.counts.covered, panel.counts.gateCurrent, panel.counts.integrated], [3,3,3,3]);
    assert.equal(panel.tasks.rows[5].stage, 'review'); assert.equal(panel.tasks.rows[6].stage, 'blocked');
    assert.equal(panel.selected.id, 't-4');
    assert.equal(JSON.stringify(panel).includes('SECRET-'), false);
    board.tasks[3].status = 'completed';
    const changed = projectPairPanel(board);
    assert.equal(changed.counts.completed, 4); assert.equal(changed.counts.gateCurrent, 3); assert.equal(changed.counts.integrated, 3);
    assert.equal(changed.progress.milestones[4],3,'completed status must not invent a gate');
    assert.equal(changed.progress.milestones[3],3,'completed status must not invent a final review');
    board.tasks[0].subject += ' amended';
    assert.equal(projectPairPanel(board).tasks.rows[0].gate.current, false);
  });
  await check('panel searches the whole board before pagination and keeps cancelled cards distinct', () => {
    const board = demoBoard();
    for (let i=9;i<=60;i++) board.tasks.push({ ...board.tasks[7], id:'t-'+i, subject: i===60?'unique-last':'task '+i });
    assert.equal(projectPairPanel(board).tasks.rows.length, 24);
    assert.equal(projectPairPanel(board,{query:'unique-last'}).tasks.rows[0].id, 't-60');
    board.tasks[3].status='cancelled';
    assert.equal(projectPairPanel(board).tasks.rows[3].stage, 'cancelled');
    assert.equal(projectPairPanel(board,{filter:'done'}).tasks.total,3);
  });
  await check('risk projection uses the actual scenario field and reports clipping separately', () => {
    const board=demoBoard();board.protocol.risks=Array.from({length:12},(_,i)=>({id:'r-'+i,severity:'P2',status:'OPEN',scenario:'failure '+i}));
    const panel=projectPairPanel(board);assert.equal(panel.riskTotal,12);assert.equal(panel.risks.length,8);assert.equal(panel.risks[0].text,'failure 0');
  });
  await check('generated browser asset is reproducible from its settings/panel sources', async () => {
    assert.equal(await readFile(new URL('../lib/client.js', import.meta.url),'utf8'), await renderClient());
    const inputs = Object.fromEntries(await Promise.all(['lib/client/settings.js', 'lib/client/panel.js', 'lib/client/panel.css']
      .map(async file => [file, await readFile(new URL('../' + file, import.meta.url), 'utf8')])));
    assert.equal(renderClient(file => inputs[file].replace(/\r?\n/g, '\r\n')), renderClient(), 'CRLF source checkouts produce the same generated JavaScript and embedded CSS');
  });
  await check('seat history stays bounded, private and separate for both Drivers', () => {
    const board = demoBoard();
    board.members[0].replacementCount = 20;
    board.members[0].seatHistory = Array.from({length:20},(_,i)=>({at:i+1,reason:'recovery',previousId:'private-session-id'}));
    const panel = projectPairPanel(board);
    assert.equal(panel.members[0].replacements,20);
    assert.equal(panel.members[0].seatHistory.length,12);
    assert.equal(panel.members[0].seatHistory[0].at,20);
    assert.equal(panel.members[1].replacements,null);
    assert.equal(JSON.stringify(panel).includes('private-session-id'),false);
  });
  await check('milestone progress shows accepted unfinished work without inflating completion', () => {
    const board=demoBoard();board.tasks.forEach(t=>{t.status='in_progress';delete t.gatePassId;});board.protocol.gatePasses=[];
    const first=projectPairPanel(board);
    assert.equal(first.counts.completed,0);assert.ok(first.progress.percent>0 && first.progress.percent<100);
    const score=first.progress.percent;
    board.protocol.cycles.push({...board.protocol.cycles[0],id:'duplicate-accepted'});
    assert.equal(projectPairPanel(board).progress.percent,score);
    board.protocol.cycles.push({id:'rework',taskId:board.tasks[0].id,step:'GREEN',verify:{verdict:'reject'}});
    assert.ok(projectPairPanel(board).progress.percent<score);
  });
  await check('ETA uses observed team throughput without a dual Driver speed multiplier',()=>{
    const board=demoBoard();
    board.tasks.forEach(t=>{t.dependencies=[];});
    const dual=projectPairPanel(board).progress.eta;
    delete board.parallel;
    const single=projectPairPanel(board).progress.eta;
    assert.equal(dual.reason,'rough');assert.deepEqual(dual,single);
    assert.ok(dual.minutes>=1 && dual.rounds>0 && dual.paceMs>=60000);
  });
  await check('ETA starts at the first passed check, refreshes with each one and stops with the team',()=>{
    const board=demoBoard();board.protocol.cycles.forEach(c=>{delete c.verify;});
    assert.equal(projectPairPanel(board).progress.eta.reason,'samples','no settled round means no pace to read');
    const [a,b]=board.protocol.cycles;
    a.verify={verdict:'checkpoint',at:a.openedAt+3*60000};
    const first=projectPairPanel(board).progress.eta;
    assert.equal(first.reason,'rough','one passed checkpoint is enough for a first estimate');
    b.verify={verdict:'checkpoint',at:first.at+2*60000};
    assert.ok(projectPairPanel(board).progress.eta.at>first.at,'the estimate is stamped with the latest passed check');
    board.protocol.phase='ABORTED';
    assert.equal(projectPairPanel(board).progress.eta.reason,'stopped');
  });
  await check('active time leaves out idle stretches and the progress projection reads no clock',()=>{
    const m=60000,span=activeSpan([0,5*m,10*m,100*m,103*m]);
    assert.equal(span.activeMs,13*m);assert.equal(span.lastAt,103*m);assert.equal(activeSpan([]).activeMs,0);
    const board=demoBoard();
    assert.equal(JSON.stringify(projectPairPanel(board).progress),JSON.stringify(projectPairPanel(board).progress));
  });
  const fixture = await mountPanelFixture();
  try {
    await check('handoff preserves progress in both Captain views without exposing the board to outsiders', async()=>{
      const original=structuredClone(fixture.board);
      const before=await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      fixture.board.handoffs=[{from:'panel-captain',to:'new-captain',at:Date.now()}];fixture.board.captainSessionId='new-captain';
      await writeTeam(fixture.root,fixture.board);
      const old=await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      const ctx={sessions:{get:()=>({header:{cwd:fixture.workspace}})}};
      const current=await readPanelSnapshot(ctx,fixture.config,{sessionId:'new-captain'});
      assert.deepEqual(old.value.team.progress,before.value.team.progress);
      assert.deepEqual(current.value.team.progress,before.value.team.progress);
      assert.equal((await fixture.rpc('snapshot',{sessionId:'outsider'})).value.team,null);
      fixture.board=original;await writeTeam(fixture.root,original);
    });
    await check('real DSH SessionStore and authenticated HostConnectionService route return the canonical board', async () => {
      const response = await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      assert.equal(response.ok,true);assert.equal(response.value.state,'ready');assert.equal(response.value.team.counts.total,8);
      const unauth = await fetch(fixture.url+'/api/pair-runtime/snapshot',{method:'POST'});
      assert.equal(unauth.status,401);
    });
    await check('panel isolates other sessions and rejects arbitrary endpoint, traversal team selector and malformed filters', async () => {
      assert.equal((await fixture.rpc('snapshot',{sessionId:'outsider'})).value.state,'empty');
      assert.equal((await fixture.rpc('snapshot',{sessionId:'missing'})).value.state,'unavailable');
      assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain',teamId:'../../other'})).value.team,null);
      for (const args of [{offset:-1},{filter:'write'},{query:42},{sessionId:''}]) assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain',...args})).ok,false);
      await assert.rejects(fixture.rpc('mutate',{sessionId:'panel-captain'}),/HTTP 404/);
    });
    await check('shared Fetch routes validate envelopes before reading a session',async()=>{
      const path=fixture.url+'/api/pair-runtime/snapshot';
      for(const body of ['{broken',JSON.stringify({type:'client-request',rpcId:'bad',method:'other',payload:{sessionId:'panel-captain'}}),JSON.stringify({type:'client-request',method:'pair-runtime/snapshot'})]){
        const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-panel-fixture':fixture.token},body});
        assert.equal(response.status,400);
      }
      const response=await fetch(path,{method:'POST',headers:{'x-panel-fixture':fixture.token},body:'{}'});
      assert.equal(response.status,415);
    });
    await check('atomic board writes refresh a native DSH long poll without waking a model', async () => {
      const first=await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      let resolved = false;
      const waiting=fixture.rpc('watch',{sessionId:'panel-captain',revision:first.value.revision}).then(result => { resolved = true; return result; });
      await new Promise(resolve=>setTimeout(resolve,80));
      await writeFile(join(fixture.root,fixture.board.id,'unrelated-write.tmp'),'not a board change');
      await new Promise(resolve=>setTimeout(resolve,80));
      assert.equal(resolved,false,'temporary-file notifications must not end a semantic watch');
      fixture.board.tasks[3].status='completed';
      await writeTeam(fixture.root,fixture.board);
      const result=await waiting;
      assert.equal(result.value.team.counts.completed,4);assert.notEqual(result.value.revision,first.value.revision);
    });
    await check('mailbox delivery backlog refreshes through the native bridge but message content never reaches the browser', async () => {
      const first=await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      const waiting=fixture.rpc('watch',{sessionId:'panel-captain',revision:first.value.revision});
      await new Promise(resolve=>setTimeout(resolve,80));
      await appendMailbox(fixture.root,fixture.board.id,'driver',createMessage('captain','driver','PRIVATE-MESSAGE'));
      const result=await waiting;
      assert.equal(result.value.team.mailboxes.find(m=>m.name==='driver').pending,1);
      assert.equal(JSON.stringify(result).includes('PRIVATE-MESSAGE'),false);
    });
    await check('native HTTP abort does not poison subsequent reads and foreign origins are rejected', async () => {
      const first=await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      const controller=new AbortController();
      const waiting=fixture.rpc('watch',{sessionId:'panel-captain',revision:first.value.revision},controller.signal);
      controller.abort();await assert.rejects(waiting,{name:'AbortError'});
      assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain'})).ok,true);
      const response=await fetch(fixture.url+'/api/pair-runtime/snapshot',{method:'POST',headers:{origin:'https://untrusted.invalid','x-panel-fixture':fixture.token}});
      assert.equal(response.status,403);
    });
    await check('history selects the active team first while keeping archived runs selectable', async () => {
      const archived=demoBoard();archived.id='archived';archived.name='Previous run';archived.protocol.phase='DONE';archived.updatedAt=Date.now()+10000;
      await createTeamDir(fixture.root,archived);
      assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain'})).value.team.id,'panel-demo');
      assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain',teamId:'archived'})).value.team.phase,'DONE');
    });
    await check('unreadable unrelated board is reported as partial data, not zero progress', async () => {
      await mkdir(join(fixture.root,'broken'));
      await writeFile(join(fixture.root,'broken','team.json'),'{broken');
      const result=await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      assert.equal(result.value.state,'ready');assert.ok(result.value.warnings.includes('board-unreadable'));
    });
    await check('cancellation and service disposal release pending watches and reject new reads', async () => {
      const service=createPanelHandler(fixture.ctx,fixture.config);
      const first=await service.handle('snapshot',{sessionId:'panel-captain'});
      const controller=new AbortController();
      const waiting=service.handle('watch',{sessionId:'panel-captain',revision:first.value.revision},controller.signal);
      controller.abort();assert.equal((await waiting).error.code,'pair-panel/cancelled');
      const pending=service.handle('watch',{sessionId:'panel-captain',revision:first.value.revision});
      service.dispose();assert.equal((await pending).error.code,'pair-panel/cancelled');
      assert.equal((await service.handle('snapshot',{sessionId:'panel-captain'})).error.code,'pair-panel/unavailable');
    });
    await check('cold session observations are disposed and use their header workspace', async () => {
      let disposed=0;
      const ctx={sessions:{get:()=>undefined},get:()=>({observeSession:async()=>({header:{cwd:fixture.workspace},[Symbol.dispose](){disposed++;}})})};
      const result=await readPanelSnapshot(ctx,fixture.config,{sessionId:'panel-captain'});
      assert.equal(result.value.state,'ready');assert.equal(disposed,1);
    });
  } finally { await fixture.close(); }
  await check('panel registers its HTTP channel when webServer arrives after connection and sessions', async () => {
    const late = await mountPanelFixture({lateWebServer:true});
    try {
      const response = await late.rpc('snapshot',{sessionId:'panel-captain'});
      assert.equal(response.ok,true);assert.equal(response.value.state,'ready');
    } finally { await late.close(); }
  });
  await check('real WebServer admits the panel route from an isolated plugin fiber', async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(WebServer,{host:'127.0.0.1',port:0});
      await ctx.plugin(SessionStore);
      const connection = new HostConnectionService(ctx,[],{isAuthenticated:()=>true});
      installFixtureApi(ctx,connection);
      const panel = ctx.plugin(c=>installPairPanel(c,{}));
      await panel;
      await new Promise(resolve=>setTimeout(resolve,40));
      const response = await fetch('http://127.0.0.1:'+ctx.get('webServer').port+'/api/pair-runtime/snapshot', {
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({type:'client-request',rpcId:'native-panel-probe',method:'pair-runtime/snapshot',payload:{sessionId:'unknown'}})
      });
      assert.equal(response.status,200);
      const body=await response.json();assert.equal(body.result.ok,true);assert.equal(body.result.value.state,'unavailable');
      await panel.dispose();
      const removed=await fetch('http://127.0.0.1:'+ctx.get('webServer').port+'/api/pair-runtime/snapshot',{method:'POST'});
      assert.equal(removed.status,404,'unloading only the panel removes its routes from the live host');
    } finally { await ctx.fiber.dispose(); }
  });
  const fresh = await mountPanelFixture({board:null});
  try {
    await check('opening the panel before team creation still detects the first board',async()=>{
      const first=await fresh.rpc('snapshot',{sessionId:'panel-captain'});
      assert.equal(first.value.state,'empty');
      const pending=fresh.rpc('watch',{sessionId:'panel-captain',revision:first.value.revision});
      await new Promise(resolve=>setTimeout(resolve,80));
      await createTeamDir(fresh.root,demoBoard());
      // Directory creation may precede the atomic file commit. A subsequent bounded read must converge.
      let result=await pending;
      if(result.value.state!=='ready')result=await fresh.rpc('snapshot',{sessionId:'panel-captain'});
      assert.equal(result.value.state,'ready');
    });
  }finally{await fresh.close();}
  const sourceText=await readFile(new URL('../lib/client/panel.js',import.meta.url),'utf8');
  const sandbox={AbortController,setTimeout,clearTimeout};vm.createContext(sandbox);vm.runInContext(sourceText,sandbox);
  // A stub that EXPANDS function components (with inert hooks), so an assertion reads rendered
  // output rather than the element a parent handed over — the plain element stub cannot see
  // inside Features, Value, Eta or Rhythm at all.
  const inertHooks = { useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {}, useLayoutEffect: () => {},
    useRef: value => ({ current: value }), useMemo: fn => fn(), useCallback: fn => fn, useDeferredValue: value => value,
    useSyncExternalStore: (subscribe, get) => get() };
  const expandingReact = new Proxy(inertHooks, { get: (target, key) => key === 'createElement'
    ? ((type, props, ...children) => typeof type === 'function' ? type({ ...(props || {}), children }) : { type, props, children })
    : target[key] });
  const DashboardOf = react => sandbox.createPairDashboard(react);
  const renderDashboard = (view, team) => JSON.stringify(DashboardOf(expandingReact)({ t: key => key, data: { team, warnings: [], teams: [], observedAt: 1 }, view, density: 'compact', status: 'live' }));
  await check('client uses the shared API, falls back only for missing routes and retries modern transport on reconnect',async()=>{
    const calls=[],timers=new Map();let seq=0;
    const source=sandbox.createPairPanelSource(async(channel,endpoint)=>{
      calls.push([channel,endpoint]);
      if(channel==='/api')throw new Error('HTTP 405');
      return {ok:true,value:{state:'empty',revision:'legacy'}};
    },{sessionId:'s'},{setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)});
    const off=source.subscribe(()=>{});await tick();
    assert.deepEqual(calls,[['/api','pair-runtime/snapshot'],['/pair-runtime','snapshot']]);
    assert.equal(source.getSnapshot().status,'live');
    source.refresh();await tick();assert.equal(calls[2][0],'/api');off();assert.equal(timers.size,0);
  });
  await check('authentication failure never falls back or displays the no-team instruction',async()=>{
    let count=0;
    const source=sandbox.createPairPanelSource(async()=>{count++;throw new Error('HTTP 401');},{sessionId:'s'});
    const off=source.subscribe(()=>{});await tick();
    assert.equal(count,1);assert.equal(source.getSnapshot().status,'error');off();
    // The hook-aware stub: the dashboard keeps the last percentage it showed, which needs a ref.
    const Dashboard=DashboardOf(expandingReact);
    for(const [error,hint] of [['HTTP 405','route'],['HTTP 401','auth'],['pair-panel/read','read'],['offline','connection']]){
      const tree=JSON.stringify(Dashboard({t:key=>key,data:null,status:'error',error,density:'compact'}));
      assert.ok(tree.includes('errorHint.'+hint));assert.ok(!tree.includes('emptyHint'));
    }
  });
  await check('client aborts hidden/unmounted subscriptions and ignores late responses after refresh',async()=>{
    const calls=[],timers=new Map();let seq=0;
    const source=sandbox.createPairPanelSource((...args)=>new Promise(resolve=>calls.push({args,resolve})),{sessionId:'s'},
      {setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)});
    const off=source.subscribe(()=>{});
    assert.equal(calls.length,1);
    source.refresh();assert.equal(calls[0].args[3].aborted,true);assert.equal(calls.length,2);
    calls[1].resolve({ok:true,value:{state:'empty',revision:'new'}});await tick();
    calls[0].resolve({ok:true,value:{state:'empty',revision:'old'}});await tick();
    assert.equal(source.getSnapshot().data.revision,'new');
    off();assert.equal(timers.size,0);
  });
  await check('client retains last good state on transport failure and backs off',async()=>{
    const timers=new Map();let seq=0,count=0;
    const source=sandbox.createPairPanelSource(async()=>{if(count++)throw new Error('offline');return {ok:true,value:{state:'ready',revision:'r'}};},{sessionId:'s'},
      {setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)});
    const off=source.subscribe(()=>{});await tick();
    const next=[...timers.values()].find(v=>v.ms===250);timers.clear();next.fn();await tick();
    assert.equal(source.getSnapshot().status,'stale');assert.equal(source.getSnapshot().data.revision,'r');
    assert.ok([...timers.values()].some(v=>v.ms===2000));
    off();
  });
  await check('seat history renders collapsed with both Driver identities', () => {
    const Dashboard=DashboardOf(expandingReact);
    const team=projectPairPanel(demoBoard());
    const tree=Dashboard({t:key=>key,data:{team,warnings:[],teams:[],observedAt:1},view:'overview',density:'compact',status:'live'});
    const found=[];
    function visit(node){if(Array.isArray(node)){node.forEach(visit);return;}if(!node||typeof node!=='object')return;if(node.props?.className==='pair-contract pair-seat-history')found.push(node);visit(node.children);}
    visit(tree);assert.equal(found.length,1);assert.equal(found[0].type,'details');assert.equal(found[0].props.open,undefined);
    const text=JSON.stringify(found[0]);assert.ok(text.includes('driver'));assert.ok(text.includes('driver-2'));assert.ok(text.includes('unknown'));
  });
  await check('activity rhythm cuts idle gaps, groups events by pipeline stage and folds tasks past six', () => {
    const at = 1_000_000_000_000, m = 60000;
    const events = [
      { at, kind: 'created', ref: 't-1', text: '' }, { at: at + 2 * m, kind: 'created', ref: 't-2', text: '' },
      { at: at + 300 * m, kind: 'cycle', ref: 't-1', text: '' }, { at: at + 310 * m, kind: 'reject', ref: 't-1', text: '' },
      { at: at + 320 * m, kind: 'accept', ref: 't-1', text: '' }, { at: at + 321 * m, kind: 'completed', ref: 't-1', text: '' },
      ...Array.from({ length: 7 }, (_, i) => ({ at: at + 330 * m + i, kind: 'created', ref: 'x-' + i, text: '' })),
    ];
    const rhythm = sandbox.pairRhythm(events.slice().reverse());
    assert.equal(rhythm.segments.length, 2, 'a 298-minute pause splits planning from building');
    assert.deepEqual({ ...rhythm.counts }, { plan: 9, build: 1, pass: 2, fail: 1 });
    assert.equal(rhythm.cycles, 1); assert.equal(rhythm.passRate, 0.5);
    assert.equal(rhythm.tasks.length, 6); assert.equal(rhythm.tasks[0].ref, 't-1'); assert.equal(rhythm.other.count, 3);
    const spread = Array.from({ length: 12 }, (_, i) => ({ at: at + i * 100 * m, kind: 'cycle', ref: 't', text: '' }));
    assert.ok(sandbox.pairRhythm(spread).segments.length <= 6, 'many idle gaps widen until the chart has at most six bursts');
    assert.equal(sandbox.pairRhythm([]).passRate, null);
  });
  await check('work time mirrors the scheduler accumulator and caps a stalled turn at one lease', () => {
    const t = key => ({ minutes: '分钟', 'duration.lt1': '<1', 'duration.h': '小时', 'duration.m': '分' })[key] ?? key;
    assert.equal(sandbox.pairDuration(30000, t), '<1'); assert.equal(sandbox.pairDuration(12 * 60000, t), '12 分钟');
    assert.equal(sandbox.pairDuration(72 * 60000, t), '1 小时 12 分'); assert.equal(sandbox.pairDuration(120 * 60000, t), '2 小时');
    const lease = 600000, now = 50_000_000;
    assert.equal(sandbox.pairWorkMs({}, lease, now).ms, null, 'no record stays unknown rather than zero');
    assert.equal(sandbox.pairWorkMs({ workMs: 1000 }, lease, now).ms, 1000);
    const live = sandbox.pairWorkMs({ workMs: 1000, workingSince: now - 5000, lastActivityAt: now - 100 }, lease, now);
    assert.equal(live.ms, 6000); assert.equal(live.live, true);
    const stalled = sandbox.pairWorkMs({ workingSince: now - 4_000_000, lastActivityAt: now - 3_000_000 }, lease, now);
    assert.equal(stalled.ms, 1_000_000 + lease); assert.equal(stalled.live, false);
  });
  await check('team to-dos merge the same seat and kind of work and keep every reference', () => {
    const groups = sandbox.pairAttentionGroups([
      { who: 'captain', kind: 'blocking-risk', tool: 'pair_risk', ref: 'r-1', why: 'close r-1' },
      { who: 'navigator', kind: undefined, tool: 'pair_verify', ref: 'c-1', why: 'verify' },
      { who: 'captain', kind: 'blocking-risk', tool: 'pair_risk', ref: 'r-2', why: 'close r-2' },
    ]);
    assert.equal(groups.length, 2); assert.equal(groups[0].refs.join(','), 'r-1,r-2'); assert.equal(groups[1].tool, 'pair_verify');
  });
  await check('member projection carries route, effort and clock-free work fields', () => {
    const board = demoBoard(), panel = projectPairPanel(board, { workingLeaseMs: 600000 });
    const [driver, , navigator] = panel.members;
    assert.equal(driver.model, 'deepseek-v4.1-flash'); assert.equal(driver.effort, 'high'); assert.equal(driver.provider, 'deepseek');
    assert.equal(typeof driver.workingSince, 'number'); assert.equal(typeof driver.lastActivityAt, 'number');
    assert.equal(navigator.workingSince, null); assert.equal(navigator.workMs, 17 * 60000); assert.equal(panel.workingLeaseMs, 600000);
    assert.equal(JSON.stringify(projectPairPanel(board, { workingLeaseMs: 600000 })), JSON.stringify(panel), 'no clock input, so an unchanged board keeps one revision');
    delete board.members[2].model; delete board.members[2].reasoningEffort; delete board.members[2].workMs;
    const legacy = projectPairPanel(board).members[2];
    assert.equal(legacy.model, null); assert.equal(legacy.effort, null); assert.equal(legacy.workMs, null);
  });
  await check('review impact counts recorded pushback, fixes and risks without inferring intent', () => {
    const board = demoBoard(), value = projectPairPanel(board).value;
    assert.deepEqual([value.noGo, value.rejects, value.fixedAfterPushback, value.repairs, value.scope, value.preexisting], [1, 2, 1, 1, 1, 0]);
    assert.deepEqual([value.settled, value.firstTry], [3, 2]);
    assert.deepEqual({ ...value.oracles }, { tasks: 6, cases: 6 });
    assert.equal(value.roles.navigator, true); assert.equal(value.roles.challenger, true);
    assert.equal(value.risks.challenger.total, 2);
    assert.deepEqual({ ...value.risks.challenger.bySeverity[1] }, { severity: 'P1', handled: 1, open: 0, dismissed: 0 });
    assert.deepEqual(value.notes.map(n => n.kind).sort(), ['fixed', 'reject', 'repair', 'risk', 'risk', 'scope']);
    assert.ok(value.notes.every((n, i, all) => i === 0 || all[i - 1].at >= n.at), 'newest first');
    assert.equal(value.reasons.length, 2);
    delete board.protocol.stats; board.members = board.members.filter(m => m.role !== 'challenger');
    const legacy = projectPairPanel(board).value;
    assert.equal(legacy.noGo, 0); assert.equal(legacy.rejects, 0); assert.equal(legacy.reasons.length, 0); assert.equal(legacy.roles.challenger, false);
  });
  await check('ETA recalculates at every step and its countdown never passes rounds not yet opened', () => {
    const board = demoBoard(), before = projectPairPanel(board).progress.eta;
    const live = board.protocol.cycles.find(c => c.id === 'c-t-4-1');
    live.step = 'GREEN'; live.green = { at: before.at + 60000 };
    const after = projectPairPanel(board).progress.eta;
    assert.ok(after.at > before.at, 'a step event stamps the estimate');
    assert.ok(after.rounds < before.rounds, 'progress inside the open round lowers the rounds still owed');
    assert.ok(after.floorMinutes >= 1 && after.floorMinutes <= after.minutes);
    const gap = 45 * 60000, total = after.minutes * 60000;
    const counted = sandbox.pairEtaMs(after, gap, after.at + 30 * 60000, true);
    assert.ok(counted.ticking && counted.ms >= after.floorMinutes * 60000 && counted.ms <= total);
    assert.equal(sandbox.pairEtaMs(after, gap, after.at + 60 * 60000, true).ms, total, 'past the idle gap nothing counts down');
    assert.equal(sandbox.pairEtaMs(after, gap, after.at + 60000, false).ms, total, 'a paused panel does not count down');
    assert.equal(sandbox.pairEtaMs({ minutes: 5, floorMinutes: 5, at: 0 }, gap, 60000, true).held, false, 'with nothing in flight there is no slow round to report');
  });
  await check('feature list rolls each goal criterion up from task cards and frozen acceptance tests', () => {
    const board = demoBoard(), features = projectPairPanel(board).features;
    assert.equal(features.length, 1); assert.equal(features[0].criteria.length, 8);
    const stages = features[0].criteria.map(c => sandbox.pairFeatureStage(c));
    assert.deepEqual(stages, ['done', 'done', 'done', 'oracle', 'oracle', 'oracle', 'allocated', 'allocated']);
    assert.deepEqual([...features[0].criteria[0].tasks], ['t-1']);
    assert.equal(features[0].criteria[0].integrated, true);
    board.tasks[7].acceptanceRefs = [];
    assert.equal(sandbox.pairFeatureStage(projectPairPanel(board).features[0].criteria[7]), 'unallocated');
    delete board.useCases;
    assert.equal(projectPairPanel(board).features.length, 0, 'a team without registered use cases shows no invented list');
  });
  await check('the green step reads as the Driver self-test, never as a passed check', () => {
    for (const dict of [sandbox.PAIR_PANEL_ZH, sandbox.PAIR_PANEL_EN]) {
      assert.ok(!/通过|passed|passing/i.test(dict['event.green']), 'the GREEN step is the Driver reporting its own test run');
    }
    assert.equal(sandbox.pairRhythmGroup('green'), 'build', 'a self-test stays on the building lane');
    assert.equal(sandbox.pairRhythmGroup('accept'), 'pass');
  });
  await check('a projection from an older host reads as "restart DSH", not as an empty feature list', () => {
    const render = renderDashboard;
    const current = projectPairPanel(demoBoard());
    assert.equal(sandbox.pairLegacyServer(current), false);
    assert.ok(!render('overview', current).includes('legacyHint'), 'a complete projection shows no restart notice');
    const older = structuredClone(current);
    // The probe names the NEWEST field the page reads, so "older" now means older than THIS batch.
    delete older.features; delete older.value;
    delete older.progress.scored; delete older.progress.terminated;
    older.progress.eta = { reason: 'rough', samples: 1, minMinutes: 3, maxMinutes: 11 };
    assert.equal(sandbox.pairLegacyServer(older), true);
    const overview = render('overview', older);
    assert.ok(overview.includes('legacyHint'), 'a host that has not restarted is named as such');
    assert.ok(overview.includes('3–11'), 'the older range projection renders the range it measured');
    const features = render('features', older), value = render('value', older);
    assert.ok(features.includes('legacyHint') && !features.includes('features.empty'));
    assert.ok(value.includes('legacyHint') && !value.includes('value.empty'));
    for (const dict of [sandbox.PAIR_PANEL_ZH, sandbox.PAIR_PANEL_EN]) assert.ok(dict['eta.blocked'], 'the pre-0.15.12 "blocked" reason has copy in both languages');
    const unknown = structuredClone(current);
    unknown.progress.eta = { reason: 'invented-later' };
    const tree = render('overview', unknown);
    assert.ok(tree.includes('eta.unknown') && !tree.includes('eta.invented-later'), 'an unknown reason falls back to readable copy, not to a raw key');
    // A host exactly one release behind (0.15.12: features and value present, scored/terminated absent)
    // used to read as current: no notice, and six milestone rows rendered as "0 / undefined" (item 10).
    const behind = structuredClone(current);
    delete behind.progress.scored; delete behind.progress.terminated;
    assert.equal(sandbox.pairLegacyServer(behind), true, 'a host without this batch\'s fields is named as old');
    const behindTree = render('overview', behind);
    assert.ok(behindTree.includes('legacyHint'), 'so the restart notice is shown for it');
    assert.ok(!behindTree.includes('undefined'), 'and the milestone rows fall back to the task total instead of printing undefined');
    assert.ok(behindTree.includes(' / 8'), 'the fallback denominator is the task total the old host sent');
    // ...and the RING has to take that same denominator. Reading the old host's percent while
    // labelling it with the task total put two bases on one hero: a board with one stopped card of
    // eight rendered "59.5%" beside "3 / 8 tasks" (measured; the percent counted the seven in play).
    const stopped = demoBoard();
    stopped.tasks[7].status = 'cancelled';
    const behindSameBoard = projectPairPanel(stopped);
    assert.equal(behindSameBoard.progress.percent, 59.5, 'the current projection scores the seven cards in play');
    assert.ok(render('overview', behindSameBoard).includes('"--pair-p":59.5'), 'and the ring carries that share');
    const behindStopped = structuredClone(behindSameBoard);
    delete behindStopped.progress.scored; delete behindStopped.progress.terminated;
    const stoppedTree = render('overview', behindStopped);
    // The ring reads its own progress variable (the disc's --pair-p), which the stub keeps in props:
    // asserting on rendered digits instead would test the counter's animation start, not the basis.
    assert.ok(stoppedTree.includes('"--pair-p":38'),
      'the ring is recomputed from the task total the old host sent (round(3 of 8 * 100) = 38), not from a share it cannot report');
    assert.ok(!stoppedTree.includes('"--pair-p":59.5'), 'so the old host never shows a percent computed from the live-card denominator it does not have');
  });
  await check('a returned proposal is one event on the failed lane, not two events on two lanes', () => {
    const board = demoBoard();
    const cycle = board.protocol.cycles[0];
    const at = board.updatedAt - 3 * 60000;
    cycle.review = { verdict: 'no_go', at, evidence: ['scope grew'] };
    cycle.pushbacks = [{ kind: 'no_go', stage: 'review', observation: 'the scope grew', at }];
    const panel = projectPairPanel(board);
    assert.equal(panel.history.filter(e => e.at === at).length, 1, 'the live NO_GO and its appended record are one event');
    assert.equal(panel.history.filter(e => e.kind === 'noGo').length, 1, 'and it carries the noGo kind, not review');
    const rhythm = sandbox.pairRhythm(panel.history);
    const failEvents = panel.history.filter(e => e.kind === 'reject' || e.kind === 'noGo').length;
    assert.equal(rhythm.counts.fail, failEvents, 'the failed lane counts each failed event exactly once');
    assert.equal(sandbox.pairRhythmGroup('noGo'), 'fail', 'and the lane matches the timeline colour');
    for (const dict of [sandbox.PAIR_PANEL_ZH, sandbox.PAIR_PANEL_EN]) {
      assert.ok(dict['event.noGo'], 'the noGo event has copy in both languages instead of falling back to the raw key');
    }
  });
  await check('every count on the page uses the cards still in play', () => {
    const board = demoBoard();
    board.tasks[7].status = 'cancelled';
    const panel = projectPairPanel(board);
    const tree = renderDashboard('overview', panel);
    assert.equal(panel.progress.scored, 7);
    assert.ok((tree.split(' / 7').length - 1) >= 4, 'the hero, the milestone rows and the card metrics count the cards still in play');
    // The acceptance metric keeps counting goal CRITERIA (8 of them here), which is not a card count:
    // the three surfaces that answer "how many cards" now all answer with the scored number.
    assert.ok(tree.includes('terminated.pre'), 'while the stopped cards are named beside the ring');
  });
  await check('the undated pushback count treats live verdicts as a set', () => {
    const board = demoBoard();
    for (const c of board.protocol.cycles) { delete c.rejections; delete c.pushbacks; }
    const cycle = board.protocol.cycles[0];
    cycle.review = { verdict: 'no_go', at: 5 };
    cycle.verify = { verdict: 'reject', at: 6 };
    cycle.rejections = 2;
    assert.equal(projectPairPanel(board).value.undatedPushbacks, 0,
      'a cycle may carry a returned proposal AND a rejected verification, and both are dated on the page');
    const orphan = structuredClone(board);
    orphan.protocol.cycles[0].rejections = 3;
    orphan.protocol.cycles[0].pushbacks = [{ kind: 'reject', stage: 'final', observation: 'no timestamp' }];
    assert.equal(projectPairPanel(orphan).value.undatedPushbacks, 1,
      'while a record with no timestamp is reported as undated instead of vanishing from both lists');
  });
  await check('the throughput denominator is measured over the same cards it scores', () => {
    const m = 60000, at = 1_000_000_000_000;
    const cycles = [{ id: 'c-1', taskId: 't-1', openedAt: at, verify: { verdict: 'checkpoint', at: at + 6 * m } }];
    const rows = [
      { id: 't-1', stage: 'coding', oracle: true, cycle: { step: 'GREEN', verdict: null }, gate: { current: false } },
      { id: 't-2', stage: 'cancelled', oracle: true, cycle: { step: 'GREEN', verdict: null }, gate: { current: false } },
    ];
    const all = [at, at + 3 * m, at + 6 * m, at + 9 * m, at + 12 * m];
    const board = { protocol: { cycles, phase: 'CYCLING' } };
    const without = panelProgress(board, rows, all);
    const withLive = panelProgress(board, rows, all, { rateStamps: all.slice(0, 4) });
    assert.ok(withLive.eta.throughputMinutes < without.eta.throughputMinutes,
      'dropping a terminated card\'s minutes from the rate makes the team look faster, not slower');
  });
  await check('a rejection a later verdict overwrote stays visible, and is never counted twice', () => {
    const board = demoBoard();
    const settled = board.protocol.cycles[1];
    assert.equal(settled.rejections, 1);
    assert.equal(projectPairPanel(board).value.undatedPushbacks, 1, 'a board written before the record existed says the time is unknown');
    settled.pushbacks = [{ kind: 'reject', stage: 'final', category: 'quality', observation: '答案没有保留，返工后通过', at: board.updatedAt - 5 * 60000 }];
    const panel = projectPairPanel(board);
    assert.equal(panel.value.undatedPushbacks, 0, 'the dated record replaces the unknown one');
    assert.equal(panel.value.notes.filter(n => n.kind === 'reject').length, 2, 'the appended reject joins the one still on the board');
    assert.ok(panel.history.some(e => e.kind === 'reject' && e.text === '答案没有保留，返工后通过'), 'the activity log shows it');
    const current = board.protocol.cycles.find(c => c.verify?.verdict === 'reject');
    current.pushbacks = [{ kind: 'reject', stage: 'final', observation: '这一轮拒绝', at: current.verify.at }];
    const deduped = projectPairPanel(board);
    assert.equal(deduped.history.filter(e => e.kind === 'reject' && e.at === current.verify.at).length, 1, 'the current verdict and its appended record are one event');
    assert.equal(deduped.value.notes.filter(n => n.text === '这一轮拒绝').length, 0, 'the review log already shows that rejection');
    assert.equal(projectPairPanel(board).value.undatedPushbacks, 0);
  });
  await check('the failed lane counts a returned proposal while the pass rate stays a verification rate', () => {
    assert.equal(sandbox.pairRhythmGroup('noGo'), 'fail');
    assert.equal(sandbox.pairRhythmGroup('green'), 'build');
    const at = 1_000_000_000_000;
    const rhythm = sandbox.pairRhythm([{ at, kind: 'accept', ref: 't-1' }, { at: at + 60000, kind: 'accept', ref: 't-2' }, { at: at + 120000, kind: 'noGo', ref: 't-1' }]);
    assert.deepEqual({ ...rhythm.counts }, { plan: 0, build: 0, pass: 2, fail: 1 });
    assert.equal(rhythm.passRate, 1, 'a proposal sent back is not a failed verification');
    // Two honest numbers under one word read as a contradiction: the lane legend counts merges and
    // completions as "passed" while the rate counts verdicts, so the rate has to name its own basis.
    assert.deepEqual({ ...rhythm.verdicts }, { passed: 2, total: 2 });
    const chart = renderDashboard('activity', projectPairPanel(demoBoard()));
    assert.ok(chart.includes('rhythm.passRateHint'), 'the rate carries the verdicts it counted');
  });
  await check('the task detail says a round in words, and its checklist does not answer itself', () => {
    const zh = key => sandbox.PAIR_PANEL_ZH[key] ?? key;
    assert.equal(sandbox.pairCycleLabel({ step: 'GO' }, zh), '方案已通过');
    assert.equal(sandbox.pairCycleLabel({ step: 'VERIFIED', verdict: 'accept' }, zh), '检查通过');
    assert.equal(sandbox.pairCycleLabel({ step: 'FUTURE_STEP' }, zh), 'FUTURE_STEP', 'a step with no word yet still prints');
    const team = projectPairPanel(demoBoard(), { taskId: 't-5' });
    assert.ok(team.selected.cycles.some(c => c.step === 'GO'), 'the fixture still carries the raw step');
    const spoken = JSON.stringify(DashboardOf(expandingReact)({ t: zh, data: { team, warnings: [], teams: [], observedAt: 1 },
      view: 'tasks', density: 'compact', status: 'live' }));
    assert.ok(spoken.includes('方案已通过') && spoken.includes('检查未通过'), 'the round badge is a sentence');
    assert.ok(!/"GO"/.test(spoken) && !/"reject"/.test(spoken), 'and no protocol token reaches it');
    const keyed = renderDashboard('tasks', team);
    assert.ok(['check.oracle', 'check.gate', 'check.integration', 'check.done'].every(k => keyed.includes(k)),
      'the checklist labels are nouns, so label + state does not read "Done: Done"');
    const fresh = projectPairPanel(demoBoard(), { taskId: 't-7' });
    assert.equal(fresh.selected.cycles.length, 0);
    assert.ok(renderDashboard('tasks', fresh).includes('cycles.empty'), 'a task with no round says so instead of leaving a bare heading');
  });
  await check('an older board reports the pushbacks it cannot date instead of an empty failed lane', () => {
    const legacy = renderDashboard('activity', projectPairPanel(demoBoard()));
    assert.ok(legacy.includes('rhythm.undatedPre'), 'the count with no recorded time is named under the chart');
    const board = demoBoard();
    board.protocol.cycles[1].pushbacks = [{ kind: 'reject', stage: 'final', observation: 'dated', at: board.updatedAt - 5 * 60000 }];
    assert.ok(!renderDashboard('activity', projectPairPanel(board)).includes('rhythm.undatedPre'), 'a board that dates its pushbacks shows no such note');
  });
  await check('a stopped card leaves the progress denominator, and a re-read board never rolls the number back', () => {
    const before = projectPairPanel(demoBoard());
    const board = demoBoard();
    board.tasks[7].status = 'cancelled';
    const after = projectPairPanel(board);
    assert.equal(after.progress.terminated, 1);
    assert.equal(after.progress.scored, before.progress.scored - 1);
    assert.ok(after.progress.percent > before.progress.percent, 'a card that can never move again must not hold the percentage down');
    assert.ok(after.progress.milestones.every(n => n <= after.progress.scored), 'milestones are scored against the cards still in play');
    const both = demoBoard(); both.tasks[3].status = 'failed'; both.tasks[7].status = 'cancelled';
    assert.deepEqual([projectPairPanel(both).progress.scored, projectPairPanel(both).progress.terminated], [6, 2]);
    assert.equal(sandbox.pairSteadyPercent(undefined, 42), 42, 'a board that could not be read keeps the last number instead of rolling back through 0');
    assert.equal(sandbox.pairSteadyPercent(null, 42), 42);
    assert.equal(sandbox.pairSteadyPercent({ percent: 0 }, 42), 0, 'a real 0 is still a 0');
    assert.equal(sandbox.pairSteadyPercent(null, undefined), 0);
    const tree = renderDashboard('overview', after);
    assert.ok(tree.includes('terminated.pre') && tree.includes('pair-terminated'), 'the stopped cards are reported on the page, not silently dropped');
    assert.ok(!renderDashboard('overview', before).includes('terminated.pre'), 'while a board with nothing stopped says nothing');
  });
  await check('the remaining estimate never undercuts what the scored stages imply', () => {
    const m = 60000, at = 1_000_000_000_000;
    const cycles = [{ id: 'c-1', taskId: 't-1', openedAt: at, verify: { verdict: 'checkpoint', at: at + 6 * m } }];
    const rows = ['t-1', 't-2', 't-3', 't-4', 't-5'].map((id, i) => ({ id, stage: i === 0 ? 'coding' : 'queued',
      oracle: i === 0, cycle: i === 0 ? { step: 'GREEN', verdict: null } : null, gate: { current: false } }));
    const stamps = [at, at + 3 * m, at + 6 * m, at + 9 * m, at + 12 * m];
    const progress = panelProgress({ protocol: { cycles, phase: 'CYCLING' } }, rows, stamps);
    assert.equal(progress.eta.basis, 'throughput', 'a card set whose stages barely move cannot be promised a short finish');
    assert.equal(progress.eta.minutes, progress.eta.throughputMinutes);
    assert.ok(progress.eta.minutes >= progress.eta.byRounds, 'the friendlier reading never wins on its own');
    assert.ok(progress.eta.floorMinutes >= 1 && progress.eta.floorMinutes <= progress.eta.minutes, 'rounds not yet opened are still never counted down past');
    assert.ok(renderDashboard('overview', projectPairPanel(demoBoard())).includes('pair-eta'), 'the estimate still renders');
  });
  await check('a board whose cards were all stopped does not read as finished (#164)', () => {
    const board = demoBoard();
    for (const task of board.tasks) task.status = 'cancelled';
    const stopped = projectPairPanel(board).progress;
    assert.equal(stopped.eta.reason, 'terminated', 'nothing is in play, so the estimate cannot say All done');
    assert.deepEqual([stopped.percent, stopped.scored, stopped.terminated], [0, 0, 8], 'and it agrees with the disc and the hero line');
    const finished = demoBoard();
    for (const task of finished.tasks) task.status = task.status === 'completed' ? 'completed' : 'cancelled';
    assert.equal(projectPairPanel(finished).progress.eta.reason, 'complete', 'a board that still has cards in play, all done, still reads complete');
  });
  await check('panel registers a conversation view plus optional sidebar and disposes both',()=>{
    const views=[],removed=[],dictionary={};
    const ctx={effect:fn=>fn(),locale:{register:(ns,d)=>{Object.assign(dictionary,d);return ()=>{};},bind:()=>key=>key},
      slots:{inject:(_,fn)=>fn(),register:(d)=>{views.push(d);return ()=>removed.push(d.name);}},
      sidebarRightTabs:{register:()=>()=>removed.push('type')},inject:(_,fn)=>{ctx.off=fn(ctx);}};
    sandbox.installPairRuntimePanel(ctx,{createElement:()=>{}});
    assert.ok(views.some(v=>v.name==='conversation.view'&&v.id==='pair-runtime'));
    assert.ok(views.some(v=>v.name==='sidebar.right.pane.tab'&&v.key==='pair-runtime'));
    assert.deepEqual(Object.keys(dictionary.zh).sort(),Object.keys(dictionary.en).sort());
    ctx.off();assert.deepEqual(removed,['sidebar.right.pane.tab','type']);
  });
}
