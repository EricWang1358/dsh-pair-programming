import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { demoBoard, mountPanelFixture } from '../scripts/panel-fixture.mjs';
import { projectPairPanel } from '../lib/runtime/panel-model.js';
import { createPanelHandler, readPanelSnapshot } from '../lib/runtime/panel-rpc.js';
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
  const fixture = await mountPanelFixture();
  try {
    await check('real DSH SessionStore and authenticated HostConnectionService route return the canonical board', async () => {
      const response = await fixture.rpc('snapshot',{sessionId:'panel-captain'});
      assert.equal(response.ok,true);assert.equal(response.value.state,'ready');assert.equal(response.value.team.counts.total,8);
      const unauth = await fetch(fixture.url+'/pair-runtime/snapshot',{method:'POST'});
      assert.equal(unauth.status,401);
    });
    await check('panel isolates other sessions and rejects arbitrary endpoint, traversal team selector and malformed filters', async () => {
      assert.equal((await fixture.rpc('snapshot',{sessionId:'outsider'})).value.state,'empty');
      assert.equal((await fixture.rpc('snapshot',{sessionId:'missing'})).value.state,'unavailable');
      assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain',teamId:'../../other'})).value.team,null);
      for (const args of [{offset:-1},{filter:'write'},{query:42},{sessionId:''}]) assert.equal((await fixture.rpc('snapshot',{sessionId:'panel-captain',...args})).ok,false);
      assert.equal((await fixture.rpc('mutate',{sessionId:'panel-captain'})).ok,false);
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
      const response=await fetch(fixture.url+'/pair-runtime/snapshot',{method:'POST',headers:{origin:'https://untrusted.invalid','x-panel-fixture':fixture.token}});
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
