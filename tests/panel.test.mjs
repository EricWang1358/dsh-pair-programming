import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoBoard, mountPanelFixture, installFixtureApi } from '../scripts/panel-fixture.mjs';
import { projectPairPanel } from '../lib/runtime/panel-model.js';
import { activeSpan } from '../lib/runtime/panel-progress.js';
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
    const Dashboard=sandbox.createPairDashboard({createElement:(type,props,...children)=>({type,props,children})});
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
    const react={createElement:(type,props,...children)=>({type,props,children})};
    const Dashboard=sandbox.createPairDashboard(react);
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
    // This stub expands function components (with inert hooks), so the assertion reads rendered output,
    // not just the element a parent handed over.
    const hooks = { useState: init => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {}, useLayoutEffect: () => {},
      useRef: value => ({ current: value }), useMemo: fn => fn(), useCallback: fn => fn, useDeferredValue: value => value,
      useSyncExternalStore: (subscribe, get) => get() };
    const react = new Proxy(hooks, { get: (target, key) => key === 'createElement'
      ? ((type, props, ...children) => typeof type === 'function' ? type({ ...(props || {}), children }) : { type, props, children })
      : target[key] });
    const Dashboard = sandbox.createPairDashboard(react);
    const render = (view, team) => JSON.stringify(Dashboard({ t: key => key, data: { team, warnings: [], teams: [], observedAt: 1 }, view, density: 'compact', status: 'live' }));
    const current = projectPairPanel(demoBoard());
    assert.equal(sandbox.pairLegacyServer(current), false);
    assert.ok(!render('overview', current).includes('legacyHint'), 'a complete projection shows no restart notice');
    const older = structuredClone(current);
    delete older.features; delete older.value;
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
