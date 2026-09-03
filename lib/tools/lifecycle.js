/**
 * Lifecycle tools: pair_start / pair_status / pair_rotate / pair_stop.
 *
 * @module dsh-pair-programming/tools/lifecycle
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock, sanitizeKey } from '../state/lock.js';
import { stateRootFor, workspaceOf, requireAgent, requireParticipantTeam, isCaptain, identityOf, deliverProtocolMessage } from './shared.js';
import { captainLockKey, teamLockKey, teamDirOf, lessonsFileOf } from '../state/layout.js';
import {
  createTeamDir, findTeamByCaptain, readTeam, writeTeam, removeTeamDir,
  recordRetiredMemberIds,
} from '../state/store.js';
import { readUnreadMailbox } from '../state/mailbox.js';
import { atomicWriteText, stripLeadingBom } from '../state/atomic.js';
import { currentCycleOf, initialProtocolState } from '../protocol/machine.js';
import { personaFor, memberWelcome } from '../protocol/personas.js';
import { resolveMemberLlmSelection, spawnMember, interruptMember } from '../runtime/members.js';
import { appendPairEvent, captainSessionOf } from '../events.js';
import { encodeMessage } from '../protocol/messages.js';
import { EvidenceCache } from '../state/evidence-cache.js';
import { TDD_MODES, PAIR_STYLES, TEAM_MODES } from '../defaults.js';
import { oracleSummary } from '../protocol/oracle.js';
import { nextObligation, obligationLine, unverifiedCycles } from '../protocol/obligation.js';
import { stallDiagnosis, goalLoopAdvice } from '../protocol/stall.js';



/**
 * Retire and interrupt every member that finished spawning, so a later failure
 * in the spawn loop cannot leave live orphan subagents. Interrupts are the
 * obligation; the retired-id record is best-effort audit (nothing reads it
 * yet), so an fs failure there must never block them.
 */
export async function retireSpawnedMembers(ctx, captain, stateRoot, members) {
  const spawned = (members ?? []).filter(m => typeof m?.id === 'string' && m.id !== '');
  const ids = spawned.map(m => m.id);
  try {
    await recordRetiredMemberIds(stateRoot, ids);
  } catch (error) {
    ctx.logger.warn(`pair-programming: retiring members ${ids.join(', ')} failed: ${String(error)}`);
  }
  for (const member of spawned) {
    interruptMember(ctx, captain, member.id);
  }
  return { retired: ids };
}

/** Read the previous session's retro keep/try lessons, if any. */
async function loadProcessLessons(stateRoot) {
  try {
    const parsed = JSON.parse(stripLeadingBom(await readFile(lessonsFileOf(stateRoot), 'utf8')));
    return parsed && Array.isArray(parsed.keep) && Array.isArray(parsed.try) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function registerLifecycleTools(ctx, config, runtime) {
  const { selections, scheduler } = runtime;

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_start',
    description: 'Start an Agile pair-programming team on a goal: you (the caller) become the captain, and this spawns the Driver (sole file writer), Navigator (reviewer + quality gate), and in full mode the Challenger (adversarial risk explorer) as durable continuable subagents with role personas. Options: tdd_mode enforce (Test-First cycles RED->GREEN->REFACTOR, default) | coach (recommended, not enforced) | off (legacy cycles); style traditional | strong | ping-pong (pairing-style semantics). Any previous session\'s retro keep/try lessons are carried into this PLANNING. One team per captain.',
    parameters: {
      goal: { type: 'string', required: true, description: 'What the pair team should accomplish.' },
      mode: { type: 'string', description: '"full" (Driver+Navigator+Challenger) or "light" (Driver+Navigator only); omitted uses configured defaultMode (full by default).' },
      tdd_mode: { type: 'string', description: 'enforce (default) | coach | off — how strictly the RED->GREEN->REFACTOR order is tool-enforced.' },
      style: { type: 'string', description: 'traditional (default) | strong (idea holder dictates, Driver is the hands) | ping-pong (test author and implementer alternate).' },
      name: { type: 'string', description: 'Optional team name (defaults to a timestamped id).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `Pair team "${value.team_id}" formed (${value.mode} mode), members: ${value.members.join(', ')}. Phase: PLANNING.` }],
    },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      // `defaultMode` is a public runtime setting.  An omitted tool argument
      // must honor it; otherwise the settings UI can display `light` while
      // every ordinary `pair_start({ goal })` silently forms a full team.
      const configuredMode = TEAM_MODES.includes(config.defaultMode) ? config.defaultMode : 'light';
      const mode = args.mode === undefined ? configuredMode : (args.mode === 'light' ? 'light' : 'full');
      const tddMode = TDD_MODES.includes(args.tdd_mode) ? args.tdd_mode : config.tddMode;
      const pairStyle = PAIR_STYLES.includes(args.style) ? args.style : config.pairStyle;
      const teamName = (args.name?.trim()) || `pair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const teamId = sanitizeKey(teamName);
      const lessons = await loadProcessLessons(stateRoot);
      return withLock(captainLockKey(stateRoot, captain.id), async () => {
        const current = await findTeamByCaptain(stateRoot, captain.id);
        if (current !== undefined) {
          throw new Error(`you already lead team "${current.name}" — pair_stop it before starting another`);
        }
        return withLock(teamLockKey(stateRoot, teamId), async () => {
          const existing = await readTeam(stateRoot, teamId);
          if (existing !== undefined) {
            throw new Error(`team id "${teamId}" is taken — pick a different name`);
          }
          const team = {
            id: teamId,
            name: teamName,
            goal: args.goal,
            mode,
            tddMode,
            pairStyle,
            processLessons: lessons ? { keep: lessons.keep, try: lessons.try, fromTeam: lessons.teamId } : undefined,
            captainSessionId: captain.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            members: [],
            tasks: [],
            taskSeq: 0,
            protocol: initialProtocolState(),
            evidenceStats: { cacheHits: 0, cacheMiss: 0 },
          };
          await createTeamDir(stateRoot, team);
          // Spawn the roles. Order matters for clarity; light mode skips the challenger.
          const roles = mode === 'light' ? ['driver', 'navigator'] : ['driver', 'navigator', 'challenger'];
          for (const role of roles) {
            const selection = await resolveMemberLlmSelection(ctx, captain, {}, exec.signal);
            const member = {
              id: '', name: role, role, provider: selection.provider, model: selection.model,
              reasoningEffort: selection.reasoningEffort, joinedAt: Date.now(), status: 'idle',
              welcome: memberWelcome(team, role),
            };
            const persona = personaFor(role)(team, member, config.stateDir);
            try {
              await spawnMember(ctx, config, selections, selection, captain, team, member, persona, exec.signal);
            } catch (error) {
              // team.members only gains an entry after its spawn resolved, so it
              // is exactly the live-orphan list: roll them back, then the dir.
              await retireSpawnedMembers(ctx, captain, stateRoot, team.members);
              await removeTeamDir(stateRoot, teamId);
              throw error;
            }
            member.persona = undefined; // persona text is delivered at spawn; keep record lean
            delete member.welcome;
            team.members.push(member);
            appendPairEvent(ctx, captain.session, 'pair/member-added', {
              teamId, memberId: member.id, name: member.name, role,
            });
          }
          team.protocol.phase = 'PLANNING';
          await writeTeam(stateRoot, team);
          // N5: put the fresh team on the heartbeat sweep list immediately, so a
          // protocol that stalls before its first kick is still recoverable.
          scheduler?.trackTeam?.(workspaceOf(captain), teamId);
          appendPairEvent(ctx, captain.session, 'pair/team-created', {
            teamId, captainSessionId: captain.id, name: teamName, goal: args.goal, mode,
          });
          return {
            team_id: teamId, team_name: teamName, mode, tdd_mode: tddMode, style: pairStyle,
            members: roles,
            liveness: goalLoopAdvice(teamId),
            carried_lessons: lessons ? { keep: lessons.keep, try: lessons.try } : null,
          };
        });
      });
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_status',
    description: 'Protocol snapshot: phase, current cycle, tasks with status, open risks, recent decisions, protocol stats, and a cache hit summary. Event-driven monitoring — do not busy-poll. members[].mailbox.pending counts messages queued and not yet seen; a delivery claimed inside its 60s lease is excluded, so a 0 can mean "in flight", not "delivered".',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(_args, exec) {
      const caller = requireAgent(exec);
      const stateRoot = stateRootFor(caller, config);
      const team = await requireParticipantTeam(caller, config);
      const p = team.protocol;
      const cycle = currentCycleOf(p);
      // One notion of 'blocking', shared with the gate: a MITIGATED P0/P1
      // still blocks completion, so it must not read as 'none' here.
      const openRisks = p.risks.filter(r => r.status === 'OPEN' || r.status === 'MITIGATED');
      const cacheTotal = p.stats.cacheHits + p.stats.cacheMiss;
      const acceptedCycles = p.cycles.filter(c => c.verify?.verdict === 'accept' && c.step === 'VERIFIED');
      const tasksDone = team.tasks.filter(t => t.status === 'completed').length;
      const pending = {};
      for (const m of team.members) {
        if (m.id === '' || m.status === 'removed') continue;
        pending[m.name] = (await readUnreadMailbox(stateRoot, team.id, m.name)).length;
      }
      const summary = [
        `Team "${team.name}" (${team.mode}, tdd=${team.tddMode ?? config.tddMode}, style=${team.pairStyle ?? config.pairStyle}) — phase ${p.phase}`,
        `Goal: ${team.goal}`,
        `Progress (working software is the only measure): ${acceptedCycles.length} accepted increment(s); ${tasksDone}/${team.tasks.length} task(s) done`,
        `Members: ${team.members.map(m => `${m.name}(${m.role}:${m.status})`).join(', ')}`,
        `Tasks: ${team.tasks.map(t => `${t.id}[${t.status}${t.assignee ? '@' + t.assignee : ''}]`).join(', ') || 'none'}`,
        `Current cycle: ${cycle ? `${cycle.id}@${cycle.step}` : 'none'}`,
        obligationLine(nextObligation(team)),
        (() => {
          const d = stallDiagnosis(team, { unread: pending, obligation: nextObligation(team) });
          return d.stalled
            ? `STALLED: ${d.reason}. Nothing restarts a stopped seat except a message from you — send the owed call above, in this turn.`
            : `Liveness: ${d.reason}`;
        })(),
        `Awaiting a verdict: ${unverifiedCycles(p).map(c => `${c.id}@${c.step}`).join(', ') || 'none'} — a task may not open another cycle while one of its own is unverified`,
        `Oracle bypasses: ${p.cycles.filter(c => c.noOracleReason).map(c => `${c.id}: ${c.noOracleReason}`).join(' · ') || 'none'}`,
        `Unresolved risks: ${openRisks.map(r => `${r.id}(${r.severity}/${r.status})`).join(', ') || 'none'} — a P0/P1 blocks completion until CLOSED (needs an executable artifact) or WONTFIX`,
        `Oracle: ${team.tasks.map(t => `${t.id}=${t.oracle === undefined ? 'NOT FROZEN' : oracleSummary(t.oracle)}`).join(' · ') || 'no tasks'}`,
        `Stats: noGo=${p.stats.noGo} reject=${p.stats.reject} attacks=${p.stats.attacks} reasons=${JSON.stringify(p.stats.reasons ?? {})} cache=${p.stats.cacheHits}/${cacheTotal || 1} hits`,
      ].join('\n');
      return {
        summary,
        phase: p.phase,
        accepted_increments: acceptedCycles.length,
        tasks_done: tasksDone,
        current_cycle: cycle ?? null,
        tasks: team.tasks,
        members: team.members.map(({ persona, welcome, ...m }) => ({ ...m, mailbox: { pending: pending[m.name] ?? 0 } })),
        open_risks: openRisks,
        stats: p.stats,
        pending_note: 'mailbox.pending counts messages that are queued and not yet seen; a delivery claimed inside its 60s lease is excluded, so 0 can mean "in flight", not "delivered".',
      };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_stop',
    description: 'End the team: interrupt all members (best effort), retire their continuable sessions, and archive the team state. Green-build rule (nobody goes home on a red build): while any work was accepted this session, a fresh full-suite green evidence line is required — unless the user explicitly confirms stopping anyway via force=true.',
    parameters: {
      reason: { type: 'string', description: 'Why the team is being dissolved.' },
      green_build_evidence: { type: 'string', description: 'Fresh whole-suite run output proving the build is green before stopping.' },
      force: { type: 'boolean', description: 'Stop despite a missing/stale green build — only after the user confirms.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Pair team "${v.team_id}" dissolved (${v.retired} member(s) retired).` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) {
        throw new Error('only the captain can stop the team');
      }
      // The lock callback has its own scope, so the count is hoisted; the early
      // return above then correctly reports zero retirements.
      let retiredCount = 0;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) return;
        if (config.greenBuildOnStop && fresh.protocol.cycles.length > 0 && !args.force) {
          if (String(args.green_build_evidence ?? '').trim() === '') {
            throw new Error('GREEN BUILD CHECK: the team shipped changes but no fresh whole-suite green evidence was supplied — run the full test suite, paste its outcome as green_build_evidence, or (only with the user\'s explicit blessing) stop with force=true');
          }
          fresh.protocol.greenBuild = { evidence: String(args.green_build_evidence).trim(), at: Date.now() };
        }
        fresh.protocol.phase = 'DONE';
        await writeTeam(stateRoot, fresh);
        retiredCount = (await retireSpawnedMembers(ctx, captain, stateRoot, fresh.members)).retired.length;
        scheduler?.untrackTeam?.(workspaceOf(captain), fresh.id);
        appendPairEvent(ctx, captain.session, 'pair/team-deleted', { teamId: fresh.id, reason: args.reason });
      });
      // Keep the state dir for audit; removing the live record's dir would lose the log.
      return { team_id: team.id, retired: retiredCount };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_interrupt',
    description: 'Captain only: cancel the current turn of one live member (best effort; the member stays spawned and reachable). Queued mailbox messages are not cleared by it — anything already delivered stays pending and shows up in bulk at the next turn, so this stops a runaway turn, not a backlog. Use it when a member is spinning, stuck mid-cycle, or repeating an approach that was already rejected.',
    parameters: {
      member: { type: 'string', required: true, description: 'Member name whose current turn should stop (e.g. "driver").' },
      reason: { type: 'string', required: true, description: 'Why the turn is cancelled; required so the control is never unexplained.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: (v.delivered ? `Interrupted the current turn of ${v.interrupted} (${v.reason}).` : `The interrupt of ${v.interrupted} could not be delivered — that member may still be running (${v.reason}).`) + ' Queued messages stay pending for the next turn.' }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can interrupt a member');
      const reason = String(args.reason ?? '').trim();
      if (reason === '') throw new Error('pair_interrupt needs a reason — an unexplained cancellation cannot be audited');
      let interrupted;
      let delivered = false;
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const wanted = String(args.member ?? '').trim();
        const member = fresh.members.find(m => m.name === wanted && m.status !== 'removed');
        if (member === undefined) throw new Error(`no active member named "${wanted}" in team "${fresh.id}"`);
        if (member.id === '') throw new Error(`member "${member.name}" has no live session to interrupt`);
        delivered = interruptMember(ctx, captain, member.id);
        interrupted = member.name;
        appendPairEvent(ctx, captain.session, 'pair/interrupted', { teamId: fresh.id, memberId: member.id, name: member.name, reason });
      });
      return { interrupted, reason, delivered };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_retro',
    description: 'Captain only: run the Sprint Retrospective when all tasks are terminal — inspect the process (rejected cycles by reason, missed risks, granularity, style fit, protocol stats), record keep/try action items. Writes retro.md, stores the keep/try lessons for the NEXT session to inherit, and moves the phase to RETRO. Do this before pair_stop.',
    parameters: {
      keep: { type: 'array', items: { type: 'string' }, description: 'What worked — the team should keep doing.' },
      try: { type: 'array', items: { type: 'string' }, description: 'What to try next session (concrete process experiments).' },
      notes: { type: 'string', description: 'Retrospective narrative: rejected cycles and why, missed risks, granularity assessment.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Retro written: ${v.keep_count} keep, ${v.try_count} try; lessons carried to the next session.` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can run the retrospective');
      const keep = (args.keep ?? []).map(s => String(s).trim()).filter(Boolean);
      const tryNext = (args.try ?? []).map(s => String(s).trim()).filter(Boolean);
      if (keep.length + tryNext.length === 0) {
        throw new Error('a retro without action items is theater — record at least one keep or try item');
      }
      const retroPath = join(teamDirOf(stateRoot, team.id), 'retro.md');
      const lessons = { at: Date.now(), teamId: team.id, keep, try: tryNext };
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const p = fresh.protocol;
        const cacheTotal = p.stats.cacheHits + p.stats.cacheMiss;
        const text = [
          `# Retrospective — ${fresh.name} (${fresh.mode}, tdd=${fresh.tddMode ?? config.tddMode}, style=${fresh.pairStyle ?? config.pairStyle})`,
          `Goal: ${fresh.goal}`,
          `Phase: ${p.phase} — ${new Date().toISOString()}`,
          '',
          '## Protocol stats (retrospective > post-mortem: improve while the project can still benefit)',
          `- accepted increments: ${p.cycles.filter(c => c.verify?.verdict === 'accept').length} / cycles opened: ${p.cycles.length}`,
          `- no_go: ${p.stats.noGo} · reject: ${p.stats.reject} · attacks: ${p.stats.attacks} · gate fails: ${p.stats.gateFails ?? 0}`,
          `- rejection reasons: ${JSON.stringify(p.stats.reasons ?? {})}`,
          `- evidence cache: ${p.stats.cacheHits}/${cacheTotal || 1} hits`,
          '',
          '## Keep',
          ...keep.map(k => `- ${k}`),
          '',
          '## Try next session',
          ...tryNext.map(t => `- ${t}`),
          '',
          args.notes ? `## Notes\n${args.notes}` : '',
        ].filter(line => line !== false).join('\n');
        await atomicWriteText(retroPath, text);
        fresh.protocol.phase = 'RETRO';
        fresh.processLessons = lessons;
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captain.session, 'pair/retro', {
          teamId: fresh.id, keep, try: tryNext,
        });
        await atomicWriteText(lessonsFileOf(stateRoot), JSON.stringify(lessons, null, 2));
      });
      return { retro_file: retroPath, keep_count: keep.length, try_count: tryNext.length };
    },
  }));

  /* -------------------------------------------------------------------- */
  ctx.tools.register(defineTool({
    name: 'pair_rotate',
    description: 'Rotate the Driver role: hand the single-writer role to another member with a handoff note (progress / open risks / next steps / pitfalls), and optionally set the pairing style going forward (traditional / strong / ping-pong). Rotate on a cadence — nobody pairs for hours straight; alternation spreads knowledge and raises the team\'s truck factor. Captain only. [Currently refused in 0.3.x — capabilities are bound at spawn time; dissolve the team with pair_stop and restart it with the roles you want].',
    parameters: {
      new_driver: { type: 'string', required: true, description: 'Member name taking over as Driver.' },
      handoff_note: { type: 'string', required: true, description: 'Progress / open risks / next steps / pitfalls for the incoming Driver.' },
      style: { type: 'string', description: 'Optional new pairing style for the team after rotation.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `Driver role rotated to "${v.new_driver}".` }] },
    async execute(args, exec) {
      const captain = requireAgent(exec);
      const stateRoot = stateRootFor(captain, config);
      const team = await requireParticipantTeam(captain, config);
      if (!isCaptain(team, captain)) throw new Error('only the captain can rotate the Driver role');
      throw new Error(`pair_rotate is refused in 0.3.x: member capabilities are bound at spawn time, so a rotation would leave the incoming Driver denied of write/edit while the outgoing Driver keeps them — I1 inverted both ways. The real fix is the dynamic write guard (M2'); until then dissolve the team with pair_stop and start it with the roles you want.`);
      if (args.style !== undefined && !PAIR_STYLES.includes(args.style)) {
        throw new Error(`unknown pairing style "${args.style}" (traditional | strong | ping-pong)`);
      }
      await withLock(teamLockKey(stateRoot, team.id), async () => {
        const fresh = await readTeam(stateRoot, team.id);
        if (fresh === undefined) throw new Error('team no longer exists');
        const incoming = fresh.members.find(m => m.name === args.new_driver && m.status !== 'removed');
        if (incoming === undefined) throw new Error(`no active member named "${args.new_driver}"`);
        const currentDriver = fresh.members.find(m => m.role === 'driver' && m.status !== 'removed');
        if (incoming.role === 'driver') throw new Error(`"${args.new_driver}" is already the Driver`);
        if (currentDriver !== undefined) currentDriver.role = incoming.role; // the old Driver inherits the incoming's former role
        incoming.role = 'driver';
        if (args.style !== undefined) fresh.pairStyle = args.style;
        await writeTeam(stateRoot, fresh);
        appendPairEvent(ctx, captainSessionOf(ctx, fresh.captainSessionId, captain.session), 'pair/rotated', {
          teamId: fresh.id, newDriver: incoming.name, style: args.style, handoff: args.handoff_note,
        });
      });
      await deliverProtocolMessage(ctx, config, captain, team, args.new_driver,
        encodeMessage('HANDOFF', {
          progress: args.handoff_note, open_risks: [], next_steps: 'see handoff note', pitfalls: 'see handoff note',
        }), exec);
      return { new_driver: args.new_driver };
    },
  }));
}
