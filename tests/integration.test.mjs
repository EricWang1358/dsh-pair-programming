import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriverWorktrees } from '../lib/runtime/worktrees.js';
import { createTeamDir, readTeam, writeTeam } from '../lib/state/store.js';
import { initialProtocolState, openCycle } from '../lib/protocol/machine.js';
import { digestOracleFiles, runOracleCommand } from '../lib/tools/oracle-exec.js';
import { registerFlowTools } from '../lib/tools/flow.js';
import { registerArbitrateTools } from '../lib/tools/arbitrate.js';
import { registerIntegrationTools } from '../lib/tools/integrate.js';
import { readMailbox } from '../lib/state/mailbox.js';
import { decodeMessage } from '../lib/protocol/messages.js';

const execute = promisify(execFile);
// K2-4: pinned against the developer's git config, and bounded (see worktrees.test.mjs).
const GIT_PINS = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'core.pager=cat', '-c', 'advice.detachedHead=false'];
const git = async (cwd, ...args) => (await execute('git', [...GIT_PINS, ...args], { cwd, encoding: 'utf8', timeout: 60_000 })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pair-integrate-'));
  await git(root, 'init'); await git(root, 'config', 'user.name', 'Integration test');
  await git(root, 'config', 'user.email', 'integration@test.invalid'); await git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'a.txt'), 'A'); await writeFile(join(root, 'b.txt'), 'B');
  await writeFile(join(root, 'regression.cjs'), "const fs=require('fs'),assert=require('assert');assert.ok(fs.readFileSync('a.txt','utf8').startsWith('A'));assert.ok(fs.readFileSync('b.txt','utf8').startsWith('B'));");
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'base');
  const parallel = { ...await createDriverWorktrees(root, join(root, '.pair-programming'), 'team'),
    verificationCommand: 'node regression.cjs', integrations: {}, pending: {} };
  const protocol = initialProtocolState();
  const team = { id: 'team', name: 'integration', goal: 'independent fixes', captainSessionId: 'cap', mode: 'light',
    tddMode: 'enforce', members: [{ id:'d1',name:'driver',role:'driver',status:'idle',joinedAt:1 },
    { id:'d2',name:'driver2',role:'driver',status:'idle',joinedAt:1 }, { id:'nav',name:'navigator',role:'navigator',status:'idle',joinedAt:1 }],
    tasks: [], taskSeq: 2, createdAt: 1, updatedAt: 1, protocol, parallel, baseline: { ref: parallel.baseHead, dirtyFiles: [] } };
  for (const [index, name] of ['driver','driver2'].entries()) {
    const id = 't-' + (index+1), file = index === 0 ? 'a.txt' : 'b.txt', content = index === 0 ? 'AA' : 'BB';
    const workspace = parallel.slots[name].path, oracleFile = '.pair-oracles/' + id + '/check.cjs';
    await mkdir(join(workspace, '.pair-oracles', id), { recursive: true });
    await writeFile(join(workspace, oracleFile), "require('assert').equal(require('fs').readFileSync('" + file + "','utf8'),'" + content + "');");
    const command = 'node ' + oracleFile;
    assert.notEqual((await runOracleCommand(workspace, command)).exit, 0);
    const oracle = { files: [oracleFile], cmd: command, sha: await digestOracleFiles(workspace,[oracleFile]), frozenAt: 1, redExit: 1, caseRefs: [] };
    const task = { id, subject: file, type: 'feature', dependencies: [], status: 'in_progress', assignee: name, attemptId: 'attempt-'+id,
      workspace, baseHead: parallel.baseHead, scope: { writes:[file],reads:[file],resources:[],declared:true }, oracle, createdAt:1,updatedAt:1 };
    team.tasks.push(task);
    const cycle = openCycle(protocol,id,{tddMode:'enforce',oracleSha:oracle.sha});
    Object.assign(cycle, { step:'GREEN',owner:{memberId:'d'+(index+1),assignee:name,attemptId:task.attemptId},
      proposal:{files:[file],verify_plan:command},review:{verdict:'go',auto:true,at:2},
      red:{evidence:['observed baseline failure'],at:1},green:{evidence:['candidate repair'],at:3},
      report:{diff_summary:file,test_results:'oracle passed',at:3} });
    await writeFile(join(workspace,file),content);
  }
  await createTeamDir(parallel.stateRoot, team);
  const config = {stateDir:'.pair-programming',tddMode:'enforce',evidenceCache:false};
  const defs=[], wakes=[], kicks=[];
  const captain={id:'cap',status:'idle',session:{header:{cwd:root},append(){}},followup:message=>wakes.push(message)};
  const ctx={tools:{register:d=>defs.push(d)},logger:{warn(){},debug(){},error(){}},
    agents:{get:id=>id==='cap'?captain:undefined},subagents:{sendMessage:async()=> 'message'}};
  const runtime={scheduler:{kickTeam:async(workspace,id)=>kicks.push({workspace,id,board:await readTeam(parallel.stateRoot,id)})}};
  registerFlowTools(ctx,config,runtime); registerArbitrateTools(ctx,config,runtime); registerIntegrationTools(ctx,config,runtime);
  const agent = id=>({id,session:{header:{cwd:id==='d1'?parallel.slots.driver.path:id==='d2'?parallel.slots.driver2.path:root},append(){}}});
  const call=(name,args,id='cap')=>defs.find(d=>d.name===name).execute(args,{agent:agent(id)});
  return {root,parallel,team,call,wakes,kicks,board:()=>readTeam(parallel.stateRoot,team.id),
    mail:async()=> (await readMailbox(parallel.stateRoot,team.id,'captain')).map(m=>decodeMessage(m.content)),
    edit:async f=>{const t=await readTeam(parallel.stateRoot,team.id);f(t);await writeTeam(parallel.stateRoot,t);},
    gate:async id=>{const board=await readTeam(parallel.stateRoot,team.id);const cycle=board.protocol.cycles.find(c=>c.taskId===id);
      const v=await call('pair_verify',{cycle_id:cycle.id,beyond_request:'nothing',preexisting_at_risk:'regression.cjs preserves both original contracts'},'nav');
      assert.equal(v.verdict,'accept'); const gate=await call('pair_gate_check',{task_id:id},id==='t-1'?'d1':'d2');assert.equal(gate.pass,true);return gate;},
    cleanup:()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})};
}
export async function run(check) {
  const scenario=async(name,fn)=>{const h=await fixture();try{await fn(h);check(true,name);}catch(e){check(false,name+': '+e.stack);}finally{await h.cleanup();}};
  await scenario('reviewed independent candidates integrate then complete and recertify together',async h=>{
    const a=await h.gate('t-1'),b=await h.gate('t-2');
    await assert.rejects(h.call('pair_task_update',{task_id:'t-1',status:'completed',attempt_id:'attempt-t-1',gate_pass_id:a.gate_pass_id},'d1'),/INTEGRATION_REQUIRED/);
    await assert.rejects(h.call('pair_integrate',{task_id:'t-1'},'d1'),/captain/);
    const first=await h.call('pair_integrate',{task_id:'t-1'});
    assert.equal(await readFile(join(h.root,'a.txt'),'utf8'),'AA');
    assert.equal(await readFile(join(h.root,'b.txt'),'utf8'),'B');
    await h.call('pair_task_update',{task_id:'t-1',status:'completed',attempt_id:'attempt-t-1',gate_pass_id:a.gate_pass_id},'d1');
    const second=await h.call('pair_integrate',{task_id:'t-2'});
    assert.equal(second.previousHead,first.head);
    assert.deepEqual(second.checks.filter(c=>c.taskId).map(c=>c.taskId),['t-1','t-2']);
    await h.call('pair_task_update',{task_id:'t-2',status:'completed',attempt_id:'attempt-t-2',gate_pass_id:b.gate_pass_id},'d2');
    assert.equal(await readFile(join(h.root,'b.txt'),'utf8'),'BB');
    const terminalMail=(await h.mail()).filter(m=>m.body?.status==='completed');
    assert.deepEqual(terminalMail.map(m=>m.body.task_id),['t-1','t-2']);
    const gatesBefore=(await h.mail()).filter(m=>m.type==='GATE_PASS').length;
    for(const id of ['t-1','t-2']) assert.equal((await h.call('pair_gate_check',{task_id:id})).pass,true);
    assert.equal((await h.mail()).filter(m=>m.type==='GATE_PASS').length,gatesBefore,'canonical recertification must not request reintegration');
  });
  await scenario('live candidate gate wakes captain once; failed or stale gates never request integration',async h=>{
    const pass=await h.gate('t-1');
    const notice=(await h.mail()).filter(m=>m.type==='GATE_PASS');
    assert.equal(notice.length,1);
    assert.equal(notice[0].body.task_id,'t-1');
    assert.equal(notice[0].body.gate_pass_id,pass.gate_pass_id);
    assert.equal(notice[0].body.workspace,h.parallel.slots.driver.path);
    assert.ok(h.wakes.some(m=>JSON.stringify(m).includes('pair_integrate')),'idle captain must receive the integration obligation');
    assert.ok(h.kicks.some(k=>k.workspace===h.root&&k.board.tasks[0].gatePassId===pass.gate_pass_id),'kick sees committed candidate gate');
    const repeated=await h.call('pair_gate_check',{task_id:'t-1'},'d1');
    assert.equal(repeated.credential_reused,true);
    assert.equal((await h.mail()).filter(m=>m.type==='GATE_PASS').length,1);
    assert.equal((await h.call('pair_gate_check',{task_id:'t-2'},'d2')).pass,false);
    await writeFile(join(h.parallel.slots.driver.path,'a.txt'),'AAA');
    await assert.rejects(h.call('pair_gate_check',{task_id:'t-1'},'d1'),/GATE_STALE/);
    assert.equal((await h.mail()).filter(m=>m.type==='GATE_PASS').length,1);
  });
  await scenario('failed and cancelled parallel tasks notify captain and release scheduler work',async h=>{
    await h.call('pair_task_update',{task_id:'t-1',status:'failed',attempt_id:'attempt-t-1',output:'blocked implementation'},'d1');
    await h.edit(t=>{t.protocol.cycles=t.protocol.cycles.filter(c=>c.taskId!=='t-2');});
    await h.call('pair_task_update',{task_id:'t-2',status:'cancelled',attempt_id:'attempt-t-2'},'d2');
    assert.deepEqual((await h.mail()).map(m=>[m.body.task_id,m.body.status]),[['t-1','failed'],['t-2','cancelled']]);
    assert.equal(h.kicks.length,2);
    assert.equal(h.kicks.at(-1).board.tasks[1].status,'cancelled');
    await assert.rejects(h.call('pair_task_update',{task_id:'t-2',status:'cancelled',attempt_id:'attempt-t-2'},'d2'));
    assert.equal((await h.mail()).length,2,'rejected terminal retry must not append duplicate mail');
  });
  await scenario('failed merged regression preserves canonical and can retry same durable candidate',async h=>{
    await h.gate('t-1');
    const head=await git(h.root,'rev-parse','HEAD');
    await h.edit(t=>{t.parallel.verificationCommand='node -e "process.exit(1)"';});
    await assert.rejects(h.call('pair_integrate',{task_id:'t-1'}),/REGRESSION_FAILED/);
    assert.equal(await git(h.root,'rev-parse','HEAD'),head);
    const pending=(await h.board()).parallel.pending['t-1'];
    assert.ok(pending.commit);
    await h.edit(t=>{t.parallel.verificationCommand='node regression.cjs';});
    const result=await h.call('pair_integrate',{task_id:'t-1'});
    assert.equal(result.candidate.commit,pending.commit);
  });
  await scenario('candidate drift after review cannot enter canonical history',async h=>{
    await h.gate('t-1');
    const head=await git(h.root,'rev-parse','HEAD');
    await writeFile(join(h.parallel.slots.driver.path,'a.txt'),'AAA');
    await assert.rejects(h.call('pair_integrate',{task_id:'t-1'}),/INTEGRATION_STALE/);
    assert.equal(await git(h.root,'rev-parse','HEAD'),head);
  });
  await scenario('a declared directory admits the file inside it end to end, proposal to merge',async h=>{
    // The workaround B3 names: the probe directory had to be moved out of the
    // repository because the guard admitted the file and integration did not.
    // Both now read one allowed write set, so the probe lands.
    await mkdir(join(h.parallel.slots.driver.path,'scratch','regression'),{recursive:true});
    await writeFile(join(h.parallel.slots.driver.path,'scratch','regression','pool-link-guard.mjs'),'probe\n');
    await h.edit(t=>{
      const task=t.tasks.find(x=>x.id==='t-1');
      task.scope={writes:['a.txt','scratch/regression'],reads:[],resources:[],declared:true};
      t.protocol.cycles.find(c=>c.taskId==='t-1').proposal.files=['a.txt','scratch/regression/pool-link-guard.mjs'];
    });
    const gate=await h.gate('t-1');
    assert.equal(gate.pass,true);
    await h.call('pair_integrate',{task_id:'t-1'});
    assert.equal(await readFile(join(h.root,'scratch','regression','pool-link-guard.mjs'),'utf8'),'probe\n');
  });
}
