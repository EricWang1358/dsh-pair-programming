import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { Config } from '@deepseek-ai/dsh-headless';
import { createDriverWorktrees } from '../lib/runtime/worktrees.js';
import { createTeamDir, writeTeam } from '../lib/state/store.js';
import { spawnMember, deliverToMember, installMemberSelectionRuntime } from '../lib/runtime/members.js';
import { retireSpawnedMembers } from '../lib/runtime/retire.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { configureIsolatedMembers, disposeIsolatedMember } from '../lib/runtime/isolated-members.js';
export { Config }; export const name='pair-dual-probe'; export const inject=['agents','sessions','headlessStartup','subagents','tools','llm'];
export function apply(ctx) { run(ctx).catch(async e=> { process.stderr.write(String(e.stack)+'\n');ctx.get('appExit')(1); }); }
async function run(ctx) {
 await ctx.get('loader')?.await();
 configureIsolatedMembers(ctx,{stateDir:'.pair-programming'});
 const selection={provider:'opencode-go-muse',model:'muse-spark-1.3-contributor'};
 const receipt={startedAt:new Date().toISOString(),routes:[],events:[]};
 const timer=setTimeout(()=>{process.stderr.write('PROBE_TIMEOUT\n');ctx.get('appExit')(1)},180000);
 const phase=process.env.DSH_PAIR_PROBE_PHASE;
 const old=phase==='resume'?JSON.parse(await readFile(join(process.cwd(),'.pair-programming/probe/team.json'),'utf8')):undefined;
 const setup=child=>{installModelSelection(child,{current:selection,assembled:undefined});};
 const parent=old?await ctx.agents.resume({resumeSessionId:old.captainSessionId,agentOptions:selection,setup}):await ctx.agents.create({sessionId:'session-'+randomUUID(),meta:{cwd:process.cwd()},agentOptions:selection,setup});
 const stateRoot=join(process.cwd(),'.pair-programming');
 const parallel=old?.parallel??await createDriverWorktrees(process.cwd(),stateRoot,'probe');
 const team=old??{id:'probe',name:'probe',mode:'light',goal:'native cwd probe',captainSessionId:parent.agent.id,parallel,members:[],tasks:[],taskSeq:0,createdAt:Date.now(),updatedAt:Date.now(),protocol:initialProtocolState()};
 if(!old) await createTeamDir(stateRoot,team);
 const stop=ctx.on('session/event',(session,event)=>{
  if(!Object.values(parallel.slots).some(s=>s.path===session.header.cwd))return;
  if(event.type==='request/context')receipt.routes.push({id:session.id,cwd:session.header.cwd,provider:event.data.provider,model:event.data.model});
  if(['tool/call','turn/start','turn/end'].includes(event.type))receipt.events.push({id:session.id,type:event.type,at:Date.now(),name:event.data.name??null,reason:event.data.reason?.kind??null});
 });
 try{
  for(const name of old?[]:['driver','driver2']){
   const member={id:'',name,role:'driver',...selection,status:'idle',joinedAt:Date.now(),welcome:'Native cwd probe'};
   await spawnMember(ctx,{stateDir:'.pair-programming',memberMaxDepth:1},installMemberSelectionRuntime(),selection,parent.agent,team,member,'You are a native DSH workspace probe. Only execute the requested shell inspection, then stop.',undefined);
   team.members.push(member);
  }
  await writeTeam(stateRoot,team);
  const results=await Promise.all(team.members.map(m=>deliverToMember(ctx,parent.agent,m.id,'Use the available shell to run Get-Location once and report its absolute path. Do not modify files or call pair tools. Then reply PROBE_DONE.')));
  receipt.deliveries=results;
  if(results.some(r=>!r.ok)) throw new Error('native delivery failed: '+JSON.stringify(results));
  await Promise.all(team.members.map(m=>ctx.agents.get(m.id).whenIdle()));
  if(!old&&receipt.routes.length<2) throw new Error('native probe did not observe both model routes');
  if(phase==='create') {
   for(const m of team.members) await ctx.sessions.flush(ctx.agents.get(m.id).session);
   await ctx.sessions.flush(parent.agent.session);
   receipt.checkpoint=team.members.map(m=>({id:m.id,name:m.name,cwd:m.workspace}));
   receipt.status='checkpoint';
   await writeFile(process.env.DSH_PAIR_SMOKE_OUTPUT,JSON.stringify(receipt,null,2));
   ctx.get('appExit')(0); return;
  }
  for(const m of team.members) {
   await ctx.sessions.flush(ctx.agents.get(m.id).session);
   await disposeIsolatedMember(ctx,m.id);
  }
  receipt.absentBeforeResume=team.members.every(m=>ctx.agents.get(m.id)===undefined);
  receipt.resumeDeliveries=await Promise.all(team.members.map(m=>deliverToMember(ctx,parent.agent,m.id,'This is a persistence recovery probe. State your current working directory from memory; do not call tools, then reply RESUME_DONE.')));
  if(receipt.resumeDeliveries.some(r=>!r.ok)) throw new Error('native resume delivery failed: '+JSON.stringify(receipt.resumeDeliveries));
  await Promise.all(team.members.map(m=>ctx.agents.get(m.id).whenIdle()));
  if(receipt.events.filter(e=>e.type==='turn/end'&&e.reason==='completed').length<4) throw new Error('native recovery did not complete both resumed turns');
  receipt.members=team.members.map(m=>({id:m.id,name:m.name,cwd:ctx.agents.get(m.id).session.header.cwd,selection:ctx.agents.get(m.id).session.requestHeader()?.config}));
  receipt.cleanup=await retireSpawnedMembers(ctx,parent.agent,stateRoot,team.members);
  team.protocol.phase='ABORTED'; await writeTeam(stateRoot,team);
  receipt.retiredDelivery=await deliverToMember(ctx,parent.agent,team.members[0].id,'This must be rejected.');
  if(receipt.retiredDelivery.ok) throw new Error('retired Driver accepted a delivery');
  receipt.endedAt=new Date().toISOString();
  await writeFile(process.env.DSH_PAIR_SMOKE_OUTPUT,JSON.stringify(receipt,null,2));
  process.stdout.write('PROBE_RESULT '+JSON.stringify(receipt)+'\n');
 } finally {await writeFile(process.env.DSH_PAIR_SMOKE_OUTPUT,JSON.stringify(receipt,null,2));clearTimeout(timer);stop();await parent.dispose();}
 ctx.get('appExit')(0);
}
