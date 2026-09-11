/**
 * The captain's write guard (M17' entrance).
 *
 * The measured failure: a captain led a full board, and then built the whole
 * product itself with 24 write + 51 edit calls. Nothing on the board was
 * violated because nothing it did ever reached the board — 0/10 tasks
 * completed, cycles=[], gatePasses=[], phase=DONE. These assertions all fail
 * on the pre-guard implementation, where every one of those calls was allowed.
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captainWriteDenial, boardWriteDenial, targetPaths, insideWorkspace, installBoardWriteGuard } from '../lib/runtime/board-guard.js';
import { createTeamDir } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';

const seat = (id, role) => ({ id, name: role, role, status: 'idle', joinedAt: 1 });
const SEATS = [seat('drv', 'driver'), seat('nav', 'navigator'), seat('chal', 'challenger')];

const team = (over = {}) => ({
  id: 'tg1', name: 'TG', goal: 'g', mode: 'full', tddMode: 'enforce', pairStyle: 'traditional',
  captainSessionId: 'cap1', createdAt: 1, updatedAt: 1, members: SEATS, tasks: [], taskSeq: 0,
  protocol: initialProtocolState(), evidenceStats: { cacheHits: 0, cacheMiss: 0 }, ...over,
});

export async function run(check) {
  const ws = await mkdtemp(join(tmpdir(), 'pair-guard-'));
  try {
    /* ---- argument shapes ------------------------------------------------ */
    check(targetPaths({ file_path: 'a.js' })[0] === 'a.js', 'targetPaths reads the common file_path key');
    check(targetPaths({ edits: [{ path: 'x.js' }, { path: 'y.js' }] }).length === 2, 'targetPaths walks nested arrays of edits');
    check(targetPaths({ content: 'not/a/path.js' }).length === 0, 'targetPaths does not mistake file CONTENT for a target');
    check(insideWorkspace(ws, 'src/a.js') && !insideWorkspace(ws, join(tmpdir(), 'scratch.txt')), 'insideWorkspace separates the product tree from a scratchpad');
    check(!insideWorkspace(ws, '../outside.js'), 'a relative escape is outside the tree');

    /* ---- the rule ------------------------------------------------------- */
    const full = team();
    const denial = captainWriteDenial(full, ws, 'edit', { file_path: 'src/index.js' });
    check(typeof denial === 'string' && denial.includes('Driver alone'), 'a full-mode captain cannot edit a workspace file — I1 becomes a property, not a printed sentence');
    check(String(denial).includes('pair_stop(outcome="aborted"') && String(denial).includes('[PAIR:PROPOSE]'), 'the refusal names both ways forward, so the captain is redirected rather than merely blocked');
    check(captainWriteDenial(full, ws, 'write', { file_path: join(tmpdir(), 'notes.md') }) === undefined, 'writes outside the workspace stay allowed: the board owns the product, not the machine');
    check(captainWriteDenial(full, ws, 'read', { file_path: 'src/index.js' }) === undefined, 'reading is untouched — a coordinator that cannot read cannot coordinate');
    check(captainWriteDenial(full, ws, 'pwsh', { command: 'git status' }) === undefined, 'shells stay open by design: the guard removes the accidental bypass, not the deliberate one');
    check(typeof captainWriteDenial(full, ws, 'apply_patch', { patch: '*** Begin Patch' }) === 'string', 'an argument shape we cannot read is refused, not waved through — a guard that fails open is no guard on the one host it did not anticipate');

    /* ---- where it must stay silent -------------------------------------- */
    check(captainWriteDenial(team({ mode: 'solo' }), ws, 'edit', { file_path: 'src/a.js' }) === undefined, 'THE exemption: in solo the captain IS the builder, and what keeps it honest is the frozen oracle, not a seat');
    check(captainWriteDenial(undefined, ws, 'edit', { file_path: 'src/a.js' }) === undefined, 'an agent leading no team is an ordinary agent');
    check(captainWriteDenial(team({ mode: 'light' }), ws, 'edit', { file_path: 'src/a.js' }) !== undefined, 'light mode has a Driver too, so it holds the same way');

    /* ---- the seat half: I1 for members, not just for the captain -------- */
    // Measured: a Challenger wrote .pair-probes/webgl-probe.html plus two PNGs
    // into the workspace and ran PowerShell, after reasoning in as many words
    // that "a throwaway probe file is not production code". The spawn filter
    // was meant to make that impossible and failed open on a host that names
    // its shell `Pwsh`. Every assertion here fails on the pre-fix build.
    const live = team();
    const probe = boardWriteDenial(live, 'chal', ws, 'write', { file_path: '.pair-probes/webgl-probe.html' });
    check(String(probe).includes('role=challenger'), 'a non-Driver seat cannot write a probe file into the workspace — I1 is about who may change the tree, not about what the change is for');
    check(String(probe).includes('pair_oracle_write'), 'the refusal points at the one write channel a review seat does have');
    check(typeof boardWriteDenial(live, 'nav', ws, 'Pwsh', { command: 'Copy-Item a b' }) === 'string', 'THE bypass that was measured: a shell under an unguessed name is refused for a review seat, because I1 says a general shell IS a write capability');
    check(boardWriteDenial(live, 'drv', ws, 'write', { file_path: 'src/a.js' }) === undefined, 'the Driver writes freely — it is the single writer, not an exception to the rule');
    check(boardWriteDenial(live, 'drv', ws, 'Pwsh', { command: 'npm test' }) === undefined, 'and keeps its shell');
    check(boardWriteDenial(live, 'nav', ws, 'read', { file_path: 'src/a.js' }) === undefined, 'a review seat still reads — a Navigator that cannot read cannot review');
    check(boardWriteDenial(live, 'nav', ws, 'write', { file_path: join(tmpdir(), 'scratch.txt') }) === undefined, 'and may write outside the tree, where it changes nothing anyone is judged on');
    check(boardWriteDenial(live, 'ghost', ws, 'write', { file_path: 'src/a.js' }) === undefined, 'an agent that holds no seat on this board is untouched by the seat rule');
    check(boardWriteDenial(team({ protocol: { ...initialProtocolState(), phase: 'ABORTED' } }), 'chal', ws, 'write', { file_path: 'a.js' }) === undefined, 'a finished board governs nobody — the same escape hatch the captain has');
    check(String(boardWriteDenial(live, 'cap1', ws, 'edit', { file_path: 'src/a.js' })).includes('captain of team'), 'the captain still routes to the captain rule, which keeps shells open');

    /* ---- installed on a real board -------------------------------------- */
    const stateRoot = join(ws, '.pair-programming');
    await mkdir(stateRoot, { recursive: true });
    await createTeamDir(stateRoot, team());
    await createTeamDir(stateRoot, team({ id: 'tg2', captainSessionId: 'cap2', protocol: { ...initialProtocolState(), phase: 'ABORTED' } }));
    await writeFile(join(ws, 'src.js'), 'x', 'utf8');

    const handlers = new Map();
    const ctx = { on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); }, logger: { debug: () => {} } };
    installBoardWriteGuard(ctx, { stateDir: '.pair-programming' });
    const pre = handlers.get('tools/pre-execute');
    check(typeof pre === 'function', 'the guard installs on the host pre-execute waterfall');
    const call = (id, name, args) => pre({ name, arguments: args, agent: { id, session: { header: { cwd: ws } } } }, async () => ({ kind: 'allow' }));

    const blocked = await call('cap1', 'edit', { file_path: 'src.js' });
    check(blocked.kind === 'deny' && String(blocked.reason).includes('tg1'), 'end to end: the live full board denies its captain the edit and names the team');
    const aborted = await call('cap2', 'edit', { file_path: 'src.js' });
    check(aborted.kind === 'allow', 'THE escape hatch: once the team is ABORTED the captain may take over — the guard is a board state, not a mode the session is stuck in');
    const stranger = await call('nobody', 'edit', { file_path: 'src.js' });
    check(stranger.kind === 'allow', 'an agent with no team on this board is untouched');
    check((await call('cap1', 'read', { file_path: 'src.js' })).kind === 'allow', 'non-mutating calls never reach a board read at all');

    /* ---- #21: an unclassifiable name is not a licence for a member --------- */
    // The deny list is built from the host's GLOBAL registry, while restrict()
    // validates a scope-aware set that also carries ANCESTOR contributions (the
    // agent-preset plane). A write tool living only there is in neither set, so both
    // layers waved it through and I1 failed open on exactly the seat it constrains.
    const known = new Set(['read', 'write', 'edit', 'pwsh', 'glob', 'grep']);
    const unclassified = (id) => boardWriteDenial(live, id, ws, 'preset_render_tool', { file_path: 'src/a.js' }, { knownToolNames: known });
    check(typeof unclassified('nav') === 'string',
      '#21 a member is refused a tool the host registry does not carry: the plugin cannot classify it, and cannot-classify must not mean allow');
    check(String(unclassified('nav')).includes('cannot classify') && String(unclassified('nav')).includes('read-only'),
      '#21 and the refusal says what it cannot do and what the remedy is, rather than naming a rule the caller cannot act on');
    check(boardWriteDenial(live, 'nav', ws, 'read', { file_path: 'src/a.js' }, { knownToolNames: known }) === undefined,
      '#21 while a name the registry DOES carry is untouched — this closes one gap, it does not restrict reading');
    check(unclassified('drv') === undefined && unclassified('drv') === undefined,
      '#21 the Driver keeps every name: I1 constrains every seat that is not the writer');
    check(unclassified('cap1') === undefined, '#21 and the captain routes to its own rule, which this does not change');
    check(boardWriteDenial(live, 'nav', ws, 'preset_render_tool', { file_path: 'src/a.js' }) === undefined,
      '#21 with no registry to compare against the rule stays off, so a host that cannot be enumerated is not bricked');

    /* ---- #21: the pre-execute filter must not swallow it first ------------- */
    const handlers2 = new Map();
    const ctx2 = { on: (n, fn) => { handlers2.set(n, fn); return () => handlers2.delete(n); }, logger: { debug: () => {} },
      tools: { schemas: () => [...known].map(name => ({ name })) } };
    installBoardWriteGuard(ctx2, { stateDir: '.pair-programming' });
    const pre2 = handlers2.get('tools/pre-execute');
    const call2 = (id, name, args) => pre2({ name, arguments: args, agent: { id, session: { header: { cwd: ws } } } }, async () => ({ kind: 'allow' }));
    const presetDenied = await call2('nav', 'preset_render_tool', { file_path: 'src.js' });
    check(presetDenied.kind === 'deny' && String(presetDenied.reason).includes('cannot classify'),
      '#21 end to end: the waterfall no longer returns early for an unclassifiable name, so the rule above is reachable at all');
    check((await call2('nav', 'read', { file_path: 'src.js' })).kind === 'allow', '#21 and a known read tool still passes the whole pipeline');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}
