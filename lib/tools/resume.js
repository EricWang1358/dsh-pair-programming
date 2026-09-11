/** Explicit Captain handoff. One board identity, fresh runtime seats, no product reset. */
import { withLock } from '../state/lock.js';
import { teamLockKey, stateRootOf } from '../state/layout.js';
import { inspectTeams, readTeam, writeTeam, findTeamByCaptain } from '../state/store.js';
import { workspaceOwner, workspaceBusyError } from '../state/ownership.js';
import { oracleDirectory, scratchDirectory } from '../state/artifacts.js';
import { personaFor, memberWelcome } from '../protocol/personas.js';
import { resolveMemberLlmSelection, seatModelRequest, spawnMember } from '../runtime/members.js';
import { retireSpawnedMembers } from '../runtime/retire.js';
import { coordinationWorkspace } from '../runtime/workspace-context.js';
import { stat } from 'node:fs/promises';

const terminal = team => ['DONE','ABORTED'].includes(team.protocol.phase);
export async function listRuns(root) {
  const runs=[];
  const scan=await inspectTeams(root);
  for (const team of scan.teams) {
    const id=team.id;
    if (team) runs.push({team_id:id,goal:team.goal,phase:team.protocol.phase,captain:team.captainSessionId,
      tasks_done:team.tasks.filter(t=>t.status==='completed').length,tasks_total:team.tasks.length,
      resumable:!terminal(team),artifact_root:oracleDirectory(team)});
  }
  return {runs,unreadable_teams:scan.errors.map(item=>item.teamId),summary:JSON.stringify(runs)};
}
export async function requireWorkspaceAvailable(ctx,root,exceptId) {
  // Judged from the boards on disk, not from what is loaded: after a host restart a
  // live board's sessions are absent from memory, and asking about loaded sessions
  // let a second team into a checkout the first one still owned (plan J2).
  const owner=await workspaceOwner(root,exceptId);
  if(owner!==undefined)throw workspaceBusyError(owner);
}
function requireQuiescent(ctx,team) {
  for (const id of [team.captainSessionId,...team.members.filter(m=>m.status!=='removed').map(m=>m.id)]) {
    // A loaded session may have queued work even when currently idle. Cold-only
    // adoption avoids racing an old Captain or a suspended verification command.
    if (ctx.agents.get(id) !== undefined) throw new Error('PAIR_RESUME_LIVE: previous Captain or member is still loaded; finish/quiesce it and resume from a new conversation after host restart');
  }
}
export async function resumeTeam(ctx,config,captain,args,runtime,signal) {
  const id=args.resume_team;
  if (typeof id!=='string'||id.length>80||!/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id)) throw new Error('resume_team must be an exact team id from pair_status(list_runs=true)');
  if (['goal','mode','drivers','use_cases','name','tdd_mode','style','integration_command'].some(key=>args[key]!==undefined)) throw new Error('Resume preserves the existing contract and composition; do not supply new-team fields');
  const workspace=coordinationWorkspace(captain.session.header.cwd),root=stateRootOf(workspace,config);
  return withLock('workspace-start:'+root,()=>withLock(teamLockKey(root,id),async()=>{
    signal?.throwIfAborted();
    const alreadyLeads=await findTeamByCaptain(root,captain.id);
    if (alreadyLeads!==undefined) {
      // Measured (#19): a cold-recovery hand-over was refused here because the session
      // still led an unclosed team in RETRO, and the refusal named neither the blocker
      // nor the way out — the same shape G6 fixed on the risk row. Name both.
      throw new Error('The new Captain already leads team "'+alreadyLeads.id+'" (phase '+String(alreadyLeads.protocol?.phase)+'), so it cannot adopt a second one: one session leads at most one non-terminal team. Close that board first with pair_stop from this session — a team in RETRO still counts as live here, because it has not been closed — or resume THAT team instead of this one.');
    }
    const original=await readTeam(root,id);
    if (!original||terminal(original)) throw new Error('Only an existing nonterminal board can be resumed; archives remain immutable');
    if (original.captainSessionId!==args.resume_from_captain || original.captainSessionId===captain.id) throw new Error('PAIR_RESUME_STALE: inspect list_runs again and supply its exact previous Captain');
    requireQuiescent(ctx,original);
    await requireWorkspaceAvailable(ctx,root,id);
    if (original.parallel) {
      if (coordinationWorkspace(original.parallel.workspace)!==workspace) throw new Error('Cannot resume in a different integration workspace');
      for (const slot of Object.values(original.parallel.slots)) if (!(await stat(slot.path)).isDirectory()) throw new Error('A preserved Driver worktree is missing');
      if (Object.keys(original.parallel.pending??{}).length) throw new Error('Finish/recover the pending integration transaction before Captain handoff');
    }
    const team=structuredClone(original),spawned=[];
    team.captainSessionId=captain.id;
    try {
      for (let i=0;i<team.members.length;i++) {
        const prior=original.members[i];if(prior.status==='removed')continue;
        const selection=await resolveMemberLlmSelection(ctx,captain,seatModelRequest(config,prior.role,team),signal);
        const member={...prior,...selection,id:'',joinedAt:Date.now(),status:'idle'};
        delete member.activity;delete member.lastTurn;delete member.resume;
        member.welcome=memberWelcome(team,member.role)+' This is a handoff, not a new project. Read pair_status before acting; preserve accepted work and check every queued message against the current board.';
        await spawnMember(ctx,config,runtime.selections,selection,captain,team,member,personaFor(member.role)(team,member,config.stateDir),signal);
        if (!member.id || member.id===original.captainSessionId || original.members.some(old=>old.id===member.id) || spawned.some(other=>other.id===member.id)) throw new Error('Replacement returned a reused or missing member identity');
        spawned.push(member);
        delete member.welcome;delete member.persona;
        member.seatHistory=[...(prior.seatHistory??[]).slice(-11),{at:member.joinedAt,reason:'recovery',previousId:prior.id,nextId:member.id}];
        member.replacementCount=(prior.replacementCount??0)+1;
        team.members[i]=member;
        for(const cycle of team.protocol.cycles){
          const task=team.tasks.find(t=>t.id===cycle.taskId);
          if(cycle.owner?.memberId===prior.id&&cycle.owner?.attemptId===task?.attemptId&&task?.assignee===member.name
            && !['accept','checkpoint'].includes(cycle.verify?.verdict)&&cycle.step!=='CLOSED')cycle.owner={...cycle.owner,memberId:member.id};
        }
      }
      signal?.throwIfAborted();requireQuiescent(ctx,original);
      team.handoffs=[...(team.handoffs??[]),{from:original.captainSessionId,to:captain.id,at:Date.now()}];
      await writeTeam(root,team);
    } catch(error) {
      await retireSpawnedMembers(ctx,captain,root,spawned);
      throw error;
    }
    const cleanup=await retireSpawnedMembers(ctx,captain,root,original.members.filter(m=>m.status!=='removed'));
    runtime.scheduler?.trackTeam?.(workspace,id);
    return {resumed:true,team_id:id,team_name:team.name,mode:team.mode,phase:team.protocol.phase,tdd_mode:team.tddMode??config.tddMode,
      members:team.members.filter(m=>m.status!=='removed').map(m=>m.name),artifact_root:oracleDirectory(team),scratch_root:scratchDirectory(team),
      tasks_done:team.tasks.filter(t=>t.status==='completed').length,tasks_total:team.tasks.length,
      cleanup_persisted:cleanup.persisted,previous_captain:original.captainSessionId,
      next:'Read pair_status. Rebuild no cards or oracles. Accepted evidence stays historical; normal gate freshness and integration checks still apply.'};
  }));
}
