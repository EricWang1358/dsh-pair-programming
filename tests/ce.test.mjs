/**
 * V5.3a — read-only Compound Engineering detection, and the closed allowlist
 * the detection is fingerprinted against.
 *
 * The rules being pinned here are the ones that keep an optional integration
 * from becoming a liability: the allowlist is closed (a CE upgrade exposes
 * nothing new by itself), the write-lane skills are named and excluded, the
 * probe never writes anything, and the recorded identity covers our own
 * exposure surface — so editing the allowlist invalidates a stale "linked"
 * state exactly like a CE upgrade does.
 */
import { join } from 'node:path';
import {
  CE_ALLOWLIST, CE_ALLOWED_NAMES, CE_WRITE_LANE, CE_DEFERRED, CE_REVIEWED_SKILL_COUNT,
  CE_SKILL_RANK, entriesForLane, allowlistDigest, isAllowed, isWriteLane, catalogCost,
  isCeSkill, CE_KNOWN_NAMES, entriesForSoloLane, entriesFor, soloCatalogCost,
} from '../lib/integrations/ce-catalog.js';
import { ceStatusLine } from '../lib/integrations/ce-status-line.js';
import { usageSectionText } from '../lib/prompt.js';
import {
  candidateRoots, inspectRoot, readCommitSha, probeCe, probeSummary, fingerprint, CE_MANIFEST,
} from '../lib/integrations/ce-probe.js';
import { installCeStatus, toStatusSection, CE_STATUS_NAMESPACE } from '../lib/integrations/ce-install.js';
import {
  makeCeProvider, installCeProvider, stripFrontmatter, boundaryPreamble, invocationFor,
  makeLaneResolver, CE_PROVIDER_NAME,
} from '../lib/integrations/ce-provider.js';
import { CE_LANES } from '../lib/defaults.js';
import { isModelInvocable, isUserInvocable } from '@deepseek-ai/dsh-skill';
import {
  appendCeLoad, readCeLoads, writeLaneViolation, taskWindowStart, ceLedgerFileOf,
} from '../lib/integrations/ce-ledger.js';
import { pushTargetFor, pushPhaseOf, currentStepOf, cePushAppendix, CE_PUSH_BUDGET } from '../lib/integrations/ce-push.js';
import { installCeLoadWatch, SKILL_TOOL_NAME } from '../lib/integrations/ce-watch.js';
import { runGate } from '../lib/protocol/gate.js';
import { completionReadiness } from '../lib/protocol/completion.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HOME = '/home/u';
const CE_ROOT = join(HOME, '.dsh', 'packages', 'compound-engineering-plugin');

/** An in-memory filesystem with the same two calls the probe is allowed to make. */
function fakeIo(files, dirs) {
  return {
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
    readdir: async (path) => {
      if (!(path in dirs)) throw new Error(`ENOENT ${path}`);
      return dirs[path].map(name => ({ name, isDirectory: () => true }));
    },
  };
}

function ceTree(over = {}) {
  const files = {
    [join(CE_ROOT, CE_MANIFEST)]: JSON.stringify({ name: 'compound-engineering', version: '3.24.0' }),
    [join(CE_ROOT, '.git', 'HEAD')]: 'ref: refs/heads/main\n',
    [join(CE_ROOT, '.git', 'refs/heads/main')]: '415181dcafe0000000000000000000000000abcd\n',
    ...over.files,
  };
  const dirs = {
    [join(CE_ROOT, 'skills')]: Array.from({ length: CE_REVIEWED_SKILL_COUNT }, (_, i) => `ce-${i}`),
    ...over.dirs,
  };
  return fakeIo(files, dirs);
}

/** A settings service stub with the register() surface the install actually uses. */
function fakeSettings() {
  const state = { ns: undefined, section: undefined, replaces: 0 };
  return {
    state,
    register(ns, schema, options) {
      state.ns = ns;
      state.section = options?.base;
      return {
        get: () => state.section,
        watch: () => () => {},
        update: async (patch) => { state.section = { ...state.section, ...patch }; },
        replace: async (section) => { state.section = section; state.replaces += 1; },
      };
    },
  };
}

export async function run(check) {
  /* ---- the allowlist is closed, partitioned, and accounted for --------- */
  const all = [...CE_ALLOWED_NAMES, ...CE_WRITE_LANE, ...CE_DEFERRED];
  check(new Set(all).size === all.length, 'no skill appears in two lists');
  check(all.length === CE_REVIEWED_SKILL_COUNT, 'the three lists account for exactly the reviewed CE release');
  check(CE_ALLOWED_NAMES.length === 12 && CE_WRITE_LANE.length === 9 && CE_DEFERRED.length === 12, '12 allowed + 9 write-lane + 12 deferred');
  check(CE_WRITE_LANE.includes('ce-work') && CE_WRITE_LANE.includes('lfg'), 'the two skills that own an execution loop are refused by name');
  check(!CE_ALLOWED_NAMES.some(isWriteLane), 'no write-lane skill can reach the allowlist');
  check(isAllowed('ce-code-review') && !isAllowed('ce-commit'), 'membership answers both ways');
  check(CE_SKILL_RANK > 600, 'CE candidates rank weaker than bundled skills, so a local skill of the same name always wins');

  /* ---- lanes decide the surface, and off means nothing at all ---------- */
  check(entriesForLane('off').length === 0, 'lane off exposes no candidate — the provider is never registered');
  check(entriesForLane('captain').every(e => e.surface === 'user'), 'lane captain exposes only user-gesture skills, so the model catalog stays empty');
  check(entriesForLane('captain').length === 5, 'five constructive skills sit on the user surface');
  check(entriesForLane('advisory').length === CE_ALLOWLIST.length, 'lane advisory exposes the whole allowlist');
  check(CE_LANES.includes('off') && CE_LANES[0] === 'off', 'off is the first and default lane');

  /* ---- our descriptions, not CE's: the catalog is charged per step ----- */
  const longest = CE_ALLOWLIST.reduce((max, e) => Math.max(max, e.description.length), 0);
  check(longest <= 110, 'every authored routing line stays short enough to be cheap in a per-step catalog');
  check(CE_ALLOWLIST.every(e => e.description.trim() !== ''), 'no skill is exposed without a routing line');
  // L1, measured (2026-09-11): this line claimed "Check each claim against the evidence…"
  // for a skill whose own frontmatter reads "Publish, read, comment on, or edit markdown in
  // Proof". A name is not a capability; the pin below fails if the guess comes back.
  const proofLine = CE_ALLOWLIST.find(e => e.name === 'ce-proof');
  check(proofLine.description.includes('Proof') && !/each claim/i.test(proofLine.description),
    'the ce-proof routing line describes what the skill DOES (Proof documents), not the claim-review sentence its name suggested');

  /* ---- candidate roots, most authoritative first ----------------------- */
  const roots = candidateRoots({ cePath: '/explicit/ce', home: HOME, installed: { plugins: { 'compound-engineering@market': [{ installPath: '/claude/ce' }] } } });
  check(roots[0].path === '/explicit/ce' && roots[0].source === 'configured', 'an explicit path outranks every discovered root');
  check(roots.some(r => r.source === 'dsh-packages') && roots.some(r => r.source === 'claude-plugins'), 'both discovery sources are consulted');
  check(candidateRoots({ home: HOME, installed: { plugins: { 'superpowers@market': [{ installPath: '/x' }] } } }).every(r => r.path !== '/x'), 'another plugin in the registry is not mistaken for CE');

  /* ---- inspection refuses anything that is not really CE --------------- */
  const io = ceTree();
  const good = await inspectRoot(CE_ROOT, io);
  check(good.ok && good.version === '3.24.0' && good.skillNames.length === CE_REVIEWED_SKILL_COUNT, 'a real checkout reports its version and skills');
  check((await inspectRoot('relative/path', io)).ok === false, 'a relative path is refused rather than resolved against a guess');
  const wrongName = ceTree({ files: { [join(CE_ROOT, CE_MANIFEST)]: JSON.stringify({ name: 'something-else' }) } });
  check((await inspectRoot(CE_ROOT, wrongName)).reason.includes('compound-engineering'), 'a manifest naming another plugin is refused');
  const noSkills = fakeIo({ [join(CE_ROOT, CE_MANIFEST)]: JSON.stringify({ name: 'compound-engineering' }) }, {});
  check((await inspectRoot(CE_ROOT, noSkills)).reason.includes('skills'), 'a checkout with no skills directory is refused');

  /* ---- commit resolution without spawning git -------------------------- */
  check((await readCommitSha(CE_ROOT, io)).startsWith('415181d'), 'a branch HEAD resolves through its ref file');
  const detached = ceTree({ files: { [join(CE_ROOT, '.git', 'HEAD')]: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' } });
  check((await readCommitSha(CE_ROOT, detached)).startsWith('deadbeef'), 'a detached HEAD holds the sha directly');
  const packed = fakeIo({
    [join(CE_ROOT, '.git', 'HEAD')]: 'ref: refs/heads/main\n',
    [join(CE_ROOT, '.git', 'packed-refs')]: '# pack-refs with: peeled\ncafe1234cafe1234cafe1234cafe1234cafe1234 refs/heads/main\n',
  }, {});
  check((await readCommitSha(CE_ROOT, packed)).startsWith('cafe1234'), 'a packed ref is still resolved');
  check((await readCommitSha('/nowhere', fakeIo({}, {}))) === undefined, 'an unresolvable commit is undefined, never a throw');

  /* ---- the probe itself ------------------------------------------------ */
  const found = await probeCe({ home: HOME, installed: undefined, now: 42 }, io);
  check(found.status === 'found' && found.source === 'dsh-packages' && found.probedAt === 42, 'the probe finds the DSH package root');
  check(found.reviewNeeded === false, 'a checkout matching the reviewed release needs no human pass');
  check(typeof found.fingerprint === 'string' && found.fingerprint.length === 16, 'a detection carries a stable fingerprint');
  check(probeSummary(found).includes('3.24.0') && probeSummary(found).includes('33 skills'), 'the summary names version and skill count');

  const drifted = ceTree({ dirs: { [join(CE_ROOT, 'skills')]: ['ce-a', 'ce-b'] } });
  const drift = await probeCe({ home: HOME, now: 1 }, drifted);
  check(drift.reviewNeeded === true, 'a skill count that no longer matches the reviewed release asks for a human pass');
  check(probeSummary(drift).includes('human pass'), 'and says so in the one line the card renders');

  const empty = await probeCe({ home: HOME, now: 1 }, fakeIo({}, {}));
  check(empty.status === 'not-found' && empty.reason.includes('never downloads'), 'a missing checkout is a rendered state, and the plugin says it will not fetch it');
  check(Array.isArray(empty.tried), 'a failed probe reports what it looked at');

  /* ---- the fingerprint covers OUR exposure surface too ------------------ */
  const base = { path: '/a', version: '1', commitSha: 'abc', skillCount: 33, allowlistDigest: allowlistDigest() };
  check(fingerprint(base) === fingerprint({ ...base }), 'the same inputs give the same fingerprint');
  check(fingerprint(base) !== fingerprint({ ...base, allowlistDigest: 'other' }), 'changing what we would expose invalidates a recorded link');
  check(fingerprint(base) !== fingerprint({ ...base, commitSha: 'def' }), 'a moved checkout invalidates a recorded link');

  /* ---- host wiring: settings as a one-shot RPC ------------------------- */
  const settings = fakeSettings();
  const resolved = { cePath: '', ceProbeToken: '' };
  const probes = [];
  const ce = installCeStatus(settings, resolved, { probe: async (opts) => { probes.push(opts); return found; } });
  check(settings.state.ns === CE_STATUS_NAMESPACE, 'detection facts get their own namespace, not the hand-edited config section');
  check(settings.state.section.status === 'unknown', 'the base layer starts as "no probe has run"');

  await ce.probeNow('t-0');
  check(probes.length === 1 && settings.state.section.status === 'found', 'an explicit probe publishes its result');
  check(settings.state.section.token === 't-0', 'the published result names the request it answered');

  ce.onSettingsCommitted({ ceProbeToken: 't-0', cePath: '' });
  check(probes.length === 1, 'the first committed snapshot is a baseline, not a request');
  ce.onSettingsCommitted({ ceProbeToken: 't-0', cePath: '' });
  check(probes.length === 1, 'an unchanged token does not re-probe — our own write must not feed itself');
  await ce.onSettingsCommitted({ ceProbeToken: 't-1', cePath: '' });
  check(probes.length === 2, 'a new token from the Detect button probes once');
  resolved.cePath = '/elsewhere';
  await ce.onSettingsCommitted({ ceProbeToken: 't-1', cePath: '/elsewhere' });
  check(probes.length === 3 && probes[2].cePath === '/elsewhere', 'a changed path re-probes, and the probe reads the live resolved config');

  const failing = installCeStatus(fakeSettings(), { cePath: '' }, { probe: async () => { throw new Error('boom'); }, logger: { warn: () => {} } });
  await failing.probeNow('t');
  check(true, 'a probe failure is contained: it logs and never rejects into the settings commit');

  check(toStatusSection(undefined).status === 'unknown' && toStatusSection(undefined).skillCount === 0, 'an absent probe flattens to scalars the schema accepts');

  /* ---- V5.3b: the provider serves the curated slice, and only that ------ */
  const bodyPath = join(CE_ROOT, 'skills', 'ce-code-review', 'SKILL.md');
  const providerIo = {
    readFile: async (path) => {
      if (path !== bodyPath) throw new Error(`ENOENT ${path}`);
      return [
        '---',
        'name: ce-code-review',
        'description: CE own description',
        '---',
        '',
        'Review the diff. Then commit and open a PR.',
      ].join('\n');
    },
  };
  const loads = [];
  let lane = 'advisory';
  const provider = makeCeProvider({
    state: () => ({ lane, probe: found }),
    io: providerIo,
    onLoad: (row) => loads.push(row),
  });
  check(provider.name === CE_PROVIDER_NAME, 'the provider registers under one stable name');

  const catalog = await provider.list({});
  check(catalog.length === CE_ALLOWLIST.length, 'the advisory catalog is exactly the allowlist, never the checkout');
  check(catalog.every(c => c.rank > 600), 'every candidate ranks weaker than bundled skills');
  check(catalog.every(c => c.description === CE_ALLOWLIST.find(e => e.name === c.name).description), 'candidates carry our authored routing lines, not CE frontmatter');
  check(catalog.every(c => c.resourceBase?.kind === 'directory'), 'each candidate points at its own bundle for relative resources');
  const review = catalog.find(c => c.name === 'ce-code-review');
  const brainstorm = catalog.find(c => c.name === 'ce-brainstorm');
  check(review.invocation.modelInvocable === true, 'an analytical skill is loadable by a seat mid-cycle');
  check(brainstorm.invocation.modelInvocable === false && brainstorm.invocation.userInvocable === true, 'a constructive skill never enters a model catalog — zero repeated tokens, human gesture only');
  check(invocationFor({ surface: 'user' }).modelInvocable === false, 'the surface decides the invocation policy');
  // Not a declaration we hope the harness honours: these are the host's own
  // predicates, and dsh-tool-skill filters the catalog with the first and
  // refuses a `skill` call with it twice. Pinned against the real package so a
  // contract change breaks here rather than silently widening the surface.
  check(isModelInvocable({ invocation: invocationFor({ surface: 'model' }) }) === true, 'an analytical row is model-invocable by the host predicate');
  check(isModelInvocable({ invocation: invocationFor({ surface: 'user' }) }) === false, 'a constructive row is not — the catalog filter drops it and the skill tool refuses it');
  check(isUserInvocable({ invocation: invocationFor({ surface: 'user' }) }) === true, 'while a human /name gesture still reaches it');

  lane = 'captain';
  const captainCatalog = await provider.list({});
  check(captainCatalog.length === 5 && captainCatalog.every(c => c.invocation.modelInvocable === false), 'lane captain publishes nothing a model catalog would ever render');
  lane = 'off';
  check((await provider.list({})).length === 0, 'lane off contributes no candidates, so no catalog tokens are sent');
  check((await provider.get(review, {})) === undefined, 'a body is refused once the lane no longer includes it');
  lane = 'advisory';

  const absent = makeCeProvider({ state: () => ({ lane: 'advisory', probe: { status: 'not-found' } }), io: providerIo });
  check((await absent.list({})).length === 0, 'no detected checkout means no candidates');

  const loaded = await provider.get(review, {});
  check(loaded.content.includes('BOUNDARY'), 'a served body states whose worktree this is before CE speaks');
  check(loaded.content.includes('Do not run this skill'), 'and forbids the execution, commit and PR steps CE assumes it owns');
  check(!loaded.content.includes('description: CE own description'), 'CE frontmatter is stripped rather than shown to the model');
  check(loaded.content.includes('Review the diff.'), 'the CE body itself arrives verbatim');
  check(loads.length === 1 && loads[0].name === 'ce-code-review', 'every load is recorded — the observation point V5.3d gates on');
  check(await provider.get({ ...review, path: '/missing/SKILL.md' }, {}) === undefined, 'an unreadable body is undefined, never a throw');

  check(stripFrontmatter(['---', 'a: 1', '---', 'body'].join('\n')).trim() === 'body', 'frontmatter stripping keeps the body');
  check(stripFrontmatter('no frontmatter here') === 'no frontmatter here', 'a body without frontmatter is untouched');
  check(boundaryPreamble('ce-x').includes('ce-x'), 'the preamble names the skill it wraps');

  // registration is one synchronous effect on a context that has ctx.skills
  let created;
  const skillCtx = { skills: { registerProvider: (factory) => { created = factory({ invalidate: () => { created.invalidated = true; } }); return () => { created.disposed = true; }; } } };
  const installed = installCeProvider(skillCtx, { state: () => ({ lane: 'off', probe: undefined }) });
  check(created?.name === CE_PROVIDER_NAME, 'installCeProvider registers exactly one provider');
  installed.refresh();
  check(created.invalidated === true, 'a lane switch invalidates the catalog instead of re-registering the provider');
  installed.dispose();
  check(created.disposed === true, 'disposal unregisters it, which is the whole detach path');

  /* ---- V5.3c: the pull catalog is opened, and its price is stated ------ */
  check(catalogCost('off').skills === 0 && catalogCost('off').chars === 0, 'lane off costs nothing');
  check(catalogCost('captain').skills === 0, 'lane captain still costs nothing in a model catalog');
  check(catalogCost('advisory').skills === 7 && catalogCost('advisory').approxTokens > 0, 'lane advisory publishes seven analytical skills and reports what they cost');
  check(catalogCost('advisory').chars < 1500, 'the authored catalog stays far under CE own frontmatter (4571 chars for the same skills)');

  check(ceStatusLine({ ceLanes: 'off' }).includes('none are billed'), 'the board line says plainly that an off lane costs nothing');
  const laneLine = ceStatusLine({ ceLanes: 'advisory', ceProbe: found });
  check(laneLine.includes('advisory') && laneLine.includes('tokens per step'), 'an active lane names itself and its repeated cost on the board');
  check(laneLine.includes('advisory') && laneLine.includes('3.24.0'), 'and names the detection it is serving from');
  check(laneLine.includes('advisory') && laneLine.includes('owns every write'), 'the board line repeats the ownership boundary, not just the fact');
  check(laneLine.includes('not served at all'), 'and says the execution/shipping skills are absent inside a team, not merely discouraged');
  check(ceStatusLine({ ceLanes: 'advisory', ceSoloLane: 'full', ceProbe: found }).includes('widens'), 'the board line names what this workspace sees when no team is live');
  check(ceStatusLine({ ceLanes: 'off', ceSoloLane: 'gesture' }).includes('gesture'), 'and does so even when the pair lane itself is off');
  check(ceStatusLine({ ceLanes: 'advisory' }).includes('no probe has run'), 'an armed lane with no detection says so rather than implying skills exist');

  const promptOff = usageSectionText({ tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'solo', ceLanes: 'off' });
  const promptOn = usageSectionText({ tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'solo', ceLanes: 'advisory' });
  check(!promptOff.includes('Compound Engineering'), 'with the lane off the system prompt is byte-identical to a build without the integration');
  check(promptOn.includes('ADVISORY') && promptOn.includes('never a silent edit'), 'an armed lane teaches the captain the boundary in the prefix');
  check(promptOn.includes('NOT served'), 'and states that the execution/shipping skills are absent inside a team, not merely discouraged');
  check(usageSectionText({ ceLanes: 'captain' }).includes('only when the user types'), 'lane captain tells the captain the skills are gesture-only');
  check(promptOn.includes('ce-proof') && promptOn.includes('ce-pov') && promptOn.includes('pair_retro'), 'an armed lane gives the captain a key-moment table (gate/arbitrate/risk-close/retro), not a per-round duty');
  check(promptOn.includes('not every round') && promptOn.includes('Routine GO and step traffic never justifies a load'), 'and pins the cadence boundary explicitly');
  check(!usageSectionText({ ceLanes: 'captain' }).includes('ce-proof'), 'lane captain carries no moment table — gesture-served skills cannot be self-loaded by a seat');
  check(!promptOff.includes('ce-proof'), 'lane off carries no cadence either');
  check(promptOn.includes('Resolve availability at the moment of need') && promptOn.includes('run the same passes natively'), 'an armed lane teaches the native fallback for the key moments when CE is not installed');
  check(promptOn.includes('no CE skill sits in your catalog') && promptOn.includes('the CE line in pair_status'), 'and grounds the fallback on observables (own catalog, pair_status CE line), not an apply-time snapshot');
  check(usageSectionText({ ceLanes: 'off', ceSoloLane: 'full' }).includes('no team live'), 'a solo-only configuration still explains what is available outside a team');
  check(!usageSectionText({ ceLanes: 'off', ceSoloLane: 'off' }).includes('Compound Engineering'), 'both lanes off keeps the prefix byte-identical to a build without the integration');

  // A lane switch changes the price without changing the disk: republish, do not re-probe.
  const laneSettings = fakeSettings();
  const laneResolved = { cePath: '', ceProbeToken: 't', ceLanes: 'off' };
  let laneProbes = 0;
  const laneCe = installCeStatus(laneSettings, laneResolved, { probe: async () => { laneProbes += 1; return found; } });
  await laneCe.probeNow('t');
  laneCe.onSettingsCommitted({ ceProbeToken: 't', cePath: '', ceLanes: 'off' });
  laneResolved.ceLanes = 'advisory';
  await laneCe.onSettingsCommitted({ ceProbeToken: 't', cePath: '', ceLanes: 'advisory' });
  check(laneProbes === 1, 'a lane switch does not re-read the filesystem — nothing on disk changed');
  check(laneSettings.state.section.lane === 'advisory' && laneSettings.state.section.catalogSkills === 7, 'but the published cost follows the new lane immediately');

  /* ---- V5.3d: the ledger, and the gate that reads it ------------------- */
  check(writeLaneViolation([]).ok === true, 'an empty window is clean');
  check(writeLaneViolation([{ name: 'ce-code-review' }]).ok === true, 'an allowlisted load is not a violation');
  const violated = writeLaneViolation([{ name: 'ce-work' }, { name: 'lfg' }, { name: 'ce-work' }]);
  check(violated.ok === false && violated.reason.includes('ce-work') && violated.reason.includes('lfg'), 'a write-lane load names every offender once');
  check(violated.reason.includes('another skill root'), 'and says where it must have come from, since this plugin never serves them');
  check(violated.reason.includes('NOT by seat'), 'the refusal is honest about how it attributed the load');
  check(violated.reason.includes('legitimate load elsewhere in this workspace lands here too'), 'and admits the false-positive edge instead of letting the user discover it');
  check(violated.reason.includes('Ways out') && violated.reason.includes('fresh task card'), 'a hard refusal still names an executable way forward');
  check(violated.reason.includes('no exemption flag'), 'and says plainly that there is no waiver, so nobody hunts for one');

  const teamForWindow = {
    createdAt: 10,
    tasks: [{ id: 't-1', createdAt: 20 }, { id: 't-2', createdAt: 30 }],
    protocol: { cycles: [{ taskId: 't-1', openedAt: 50 }, { taskId: 't-1', openedAt: 70 }] },
  };
  check(taskWindowStart(teamForWindow, 't-1') === 50, 'a task window starts at its earliest cycle');
  check(taskWindowStart(teamForWindow, 't-2') === 30, 'a task with no cycles yet still has a window from its own creation');

  const dir = await mkdtemp(join(tmpdir(), 'pair-ce-'));
  try {
    const emptyRead = await readCeLoads(dir, 0);
    check(emptyRead.readable === true && emptyRead.loads.length === 0, 'a ledger that was never written is readable and empty, not an error');
    await appendCeLoad(dir, { name: 'ce-code-review', at: 100 });
    await appendCeLoad(dir, { name: 'ce-work', at: 200 });
    const since = await readCeLoads(dir, 150);
    check(since.loads.length === 1 && since.loads[0].name === 'ce-work', 'reads are bounded by the window');
    check((await readCeLoads(dir, 0)).loads.length === 2, 'every served body is on the record');
    await writeFile(ceLedgerFileOf(dir), 'not json at all\n', 'utf8');
    const broken = await readCeLoads(dir, 0);
    check(broken.readable === false, 'an unreadable ledger is distinguishable from an empty one — "we could not look" must not pass as "nothing happened"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const gateTeam = {
    tddMode: 'off',
    tasks: [{ id: 't-1', createdAt: 1 }],
    protocol: {
      phase: 'DEVELOPING', risks: [], decisions: [], gatePasses: [],
      cycles: [{ id: 'c-1', taskId: 't-1', openedAt: 2, step: 'GREEN', verify: { verdict: 'accept', computed: true, evidence: ['ran'], at: 3 } }],
    },
  };
  const cleanGate = runGate(gateTeam, 't-1', { dod: ['all_accepted'], ceLoads: { readable: true, loads: [], violation: { ok: true } } });
  check(cleanGate.pass === true && cleanGate.checklist.ceLoads.count === 0, 'a clean window issues the credential and records that it looked');
  const dirtyGate = runGate(gateTeam, 't-1', { dod: ['all_accepted'], ceLoads: { readable: true, loads: [{ name: 'ce-work' }], violation: writeLaneViolation([{ name: 'ce-work' }]) } });
  check(dirtyGate.pass === false && dirtyGate.failures.some(f => f.includes('ce-work')), 'a second execution loop in the window refuses the gate credential');
  const blindGate = runGate(gateTeam, 't-1', { dod: ['all_accepted'], ceLoads: { readable: false, loads: [] } });
  check(blindGate.pass === false && blindGate.failures.some(f => f.includes('could not be read')), 'an unreadable ledger fails the gate rather than passing by default');
  check(runGate(gateTeam, 't-1', { dod: ['all_accepted'] }).pass === true, 'a deployment that never wired the ledger is unaffected');

  const stopTeam = { ...gateTeam, id: 'x', createdAt: 1, processLessons: { at: 9 } };
  const stopFail = completionReadiness(stopTeam, { greenEvidence: 'green', ceLoads: { readable: true, loads: [{ name: 'lfg' }], violation: writeLaneViolation([{ name: 'lfg' }]) } });
  check(stopFail.failures.some(f => f.includes('lfg')), 'the same rule blocks the completion receipt, not only one task credential');

  /* ---- V5.3d: the one phase-bound push --------------------------------- */
  // The trigger these pin is the SECOND one. The first (`cycleStep ===
  // 'REFACTOR'`) was unreachable three ways over, and no unit test on
  // pushTargetFor alone could have seen it — hence the integration check below.
  const liveTask = { id: 't-1', status: 'in_progress' };
  const preGreen = { tasks: [liveTask], protocol: { cycles: [{ taskId: 't-1', step: 'GREEN' }] } };
  const postGreen = { tasks: [liveTask], protocol: { cycles: [{ taskId: 't-1', step: 'GREEN', verify: { verdict: 'accept', at: 9 } }] } };
  check(pushPhaseOf(preGreen) === 'pre-green', 'before any accept, the task is pre-green');
  check(pushPhaseOf(postGreen) === 'post-green', 'after an accept it is post-green — which is exactly the respawn boundary');
  check(pushPhaseOf({ tasks: [] }) === undefined, 'no task in flight, no phase');
  check(pushPhaseOf({ tasks: [{ id: 't-1', status: 'completed' }], protocol: { cycles: [] } }) === undefined, 'a completed task is not in flight');

  check(pushTargetFor({ lane: 'advisory', role: 'driver', phase: 'post-green' }) === undefined, 'lane advisory is pull-only — push is exactly what full adds');
  check(pushTargetFor({ lane: 'full', role: 'navigator', phase: 'post-green' }) === undefined, 'only the Driver is handed the simplification aid');
  check(pushTargetFor({ lane: 'full', role: 'driver', phase: 'pre-green' }) === undefined, 'and only once behaviour is green — otherwise it is advice about work that does not exist');
  check(pushTargetFor({ lane: 'full', role: 'driver', phase: 'post-green' }) === 'ce-simplify-code', 'the one push case resolves to one skill');

  check(currentStepOf({ protocol: { cycles: [{ step: 'REFACTOR' }] } }) === 'REFACTOR', 'the open cycle decides the step');
  check(currentStepOf(postGreen) === undefined, 'a settled cycle is not a step anyone is in — which is why the step could not be the trigger');

  const pushCache = new Map();
  let bodyLoads = 0;
  const pushDeps = {
    lane: 'full', role: 'driver', team: postGreen, cache: pushCache,
    probe: { commitSha: 'abc123' },
    load: async () => { bodyLoads += 1; return { content: `BOUNDARY
${'x'.repeat(9000)}` }; },
  };
  const appendix = await cePushAppendix(pushDeps);
  check(appendix.includes('Simplification aid'), 'the appendix labels itself');
  check(appendix.includes('advice about shape, not about scope'), 'and re-states that clean-up does not license behaviour changes');
  check(appendix.includes('trimmed to'), 'an oversized body is trimmed with the cut declared, not silently truncated');
  check(appendix.length < 9000, 'the persona prefix stays bounded');
  await cePushAppendix(pushDeps);
  check(bodyLoads === 1, 'the body is cached per CE commit — a per-cycle respawn does not re-read it');
  await cePushAppendix({ ...pushDeps, probe: { commitSha: 'def456' } });
  check(bodyLoads === 2, 'a moved CE commit misses the cache, which is exactly when it must');
  check(await cePushAppendix({ ...pushDeps, lane: 'advisory' }) === '', 'nothing is pushed outside lane full');
  check(await cePushAppendix({ ...pushDeps, cache: new Map(), load: async () => undefined }) === '', 'an unavailable body pushes nothing rather than half a persona');
  check(await cePushAppendix({ ...pushDeps, cache: new Map(), load: async () => { throw new Error('x'); } }) === '', 'a failing load never breaks a respawn');
  check(CE_PUSH_BUDGET > 0, 'the push budget is declared, not implicit');

  /* ---- 0.11.1: loads this plugin did NOT serve are still observed ------ */
  // The configuration this fixes: a user symlinks a CE checkout into
  // ~/.agents/skills, so every load is served by dsh-skill-filesystem and our
  // own provider ledger stays empty — which made the gate's write-lane refusal
  // unable to fire on the one case it was written for.
  check(isCeSkill('ce-work') && isCeSkill('lfg') && isCeSkill('ce-optimize'), 'every CE name is recognised, not only the allowlisted ones');
  check(!isCeSkill('some-local-skill'), 'a non-CE skill is not claimed');
  check(CE_KNOWN_NAMES.length === CE_REVIEWED_SKILL_COUNT, 'the known set is the whole reviewed release');

  const watchDir = await mkdtemp(join(tmpdir(), 'pair-cew-'));
  try {
    const listeners = [];
    const watchCtx = { on: (event, fn) => { listeners.push([event, fn]); return () => {}; } };
    installCeLoadWatch(watchCtx, { stateDir: '.' });
    check(listeners[0][0] === 'tools/pre-execute', 'the observer sits on the tool pipeline, where every provider is visible');
    const fire = listeners[0][1];
    const agent = { id: 'a-1', session: { header: { cwd: watchDir } } };
    let passed = 0;
    const next = async () => { passed += 1; };

    await fire({ name: 'read_file', arguments: {}, agent }, next);
    await fire({ name: SKILL_TOOL_NAME, arguments: { name: 'some-local-skill' }, agent }, next);
    await fire({ name: SKILL_TOOL_NAME, arguments: { name: 'ce-work' }, agent }, next);
    await fire({ name: SKILL_TOOL_NAME, arguments: { name: 'ce-code-review' }, agent }, next);
    check(passed === 4, 'the observer never denies a call — loading is not the violation, issuing a credential afterwards is');
    await new Promise(r => setTimeout(r, 20));
    const seen = await readCeLoads(watchDir, 0);
    check(seen.loads.length === 2, 'only CE skills are recorded, and both lanes are');
    check(seen.loads.some(row => row.name === 'ce-work' && row.via === 'skill-tool'), 'a write-lane load from a foreign skill root now reaches the ledger');
    check(writeLaneViolation(seen.loads).ok === false, 'and the gate can therefore actually refuse — the check is no longer unreachable');

    await fire({ name: SKILL_TOOL_NAME, arguments: { name: 'ce-work' }, agent: { id: 'x' } }, next);
    check((await readCeLoads(watchDir, 0)).loads.length === 2, 'a call with no workspace records nothing rather than guessing one');
  } finally {
    await rm(watchDir, { recursive: true, force: true });
  }
  check(typeof installCeLoadWatch({}, {}) === 'function', 'a host with no tool waterfall gets a no-op disposer, not a crash');

  /* ---- V5.5: two lanes, chosen by whether a team is live --------------- */
  check(entriesForSoloLane('off').length === 0, 'solo off exposes nothing');
  check(entriesForSoloLane('gesture').length === CE_REVIEWED_SKILL_COUNT, 'solo gesture keeps every skill at hand');
  check(entriesForSoloLane('gesture').every(e => e.surface === 'user'), 'and none of them enter a model catalog — zero repeated tokens');
  check(soloCatalogCost('gesture').approxTokens === 0, 'so the gesture lane is literally free per step');
  check(entriesForSoloLane('full').length === CE_REVIEWED_SKILL_COUNT, 'solo full serves the whole release');
  check(entriesForSoloLane('full').some(e => e.name === 'ce-work'), 'including the execution skills — outside a team, that is what CE is for');
  check(entriesForSoloLane('curated').length === CE_ALLOWLIST.length, 'solo curated is the pair allowlist');
  check(soloCatalogCost('full').chars < 3000, 'even the widest lane stays under a third of CE own frontmatter (7,487 chars)');

  check(entriesFor({ lane: 'advisory', soloLane: 'full', teamLive: true }).every(e => !isWriteLane(e.name)), 'a live team never sees an execution skill, whatever the solo lane says');
  check(entriesFor({ lane: 'advisory', soloLane: 'full', teamLive: false }).some(e => e.name === 'lfg'), 'and the same workspace widens the moment no team is live');
  check(entriesFor({ lane: 'off', soloLane: 'full', teamLive: true }).length === 0, 'the pair lane still wins while a team is live');

  const laneCalls = [];
  const resolver = makeLaneResolver({ teamLive: async (cwd) => { laneCalls.push(cwd); return cwd === '/with-team'; }, ttlMs: 10_000, now: () => 1000 });
  check(await resolver('/with-team') === true && await resolver('/no-team') === false, 'the resolver answers per workspace');
  await resolver('/with-team');
  check(laneCalls.length === 2, 'and caches, because list() runs on every catalog refresh');
  check(await resolver('') === false, 'an unknown cwd is treated as no team rather than guessed');
  const blind = makeLaneResolver({ teamLive: async () => { throw new Error('unreadable'); } });
  check(await blind('/x') === true, 'an unreadable state directory errs narrow: assume a team is live rather than widening the lane');

  const dualProvider = makeCeProvider({
    state: () => ({ lane: 'advisory', soloLane: 'full', probe: found }),
    laneOf: async (cwd) => cwd === '/paired',
    io: providerIo,
  });
  const paired = await dualProvider.list({ cwd: '/paired' });
  const alone = await dualProvider.list({ cwd: '/alone' });
  check(paired.length === CE_ALLOWLIST.length && alone.length === CE_REVIEWED_SKILL_COUNT, 'one provider serves both lanes, decided by the board');
  check(!paired.some(c => c.name === 'ce-work') && alone.some(c => c.name === 'ce-work'), 'the execution skills appear only where there is no protocol to break');
  const pairedBody = await dualProvider.get(paired.find(c => c.name === 'ce-code-review'), { cwd: '/paired' });
  const soloBody = await dualProvider.get(alone.find(c => c.name === 'ce-code-review'), { cwd: '/alone' });
  check(pairedBody.content.includes('BOUNDARY'), 'inside a team the body states whose worktree it is');
  check(!soloBody.content.includes('BOUNDARY'), 'outside a team it does not — there is no protocol to claim ownership on behalf of');
  check(soloBody.content.includes('Review the diff.'), 'and the CE body itself is unchanged either way');

  /* ---- the composition the unit tests could not see -------------------- */
  // Every piece below passed its own unit test while the assembled path was
  // dead: the push loader called the provider with no cwd, the resolver read
  // that as "no team", the solo lane served (or, at its default, did not serve)
  // the body, and a live team's seat would have received a persona with no
  // ownership boundary in it. This exercises the wiring, not the pieces.
  const simplifyPath = join(CE_ROOT, 'skills', 'ce-simplify-code', 'SKILL.md');
  const pushIo = {
    readFile: async (path) => {
      if (path !== simplifyPath) throw new Error(`ENOENT ${path}`);
      return ['---', 'name: ce-simplify-code', 'description: CE own', '---', '', 'Look for duplication.'].join('\n');
    },
  };
  const pushLedger = [];
  const wiredProvider = makeCeProvider({
    // The shipped defaults: the solo lane is off, so a push that resolves to
    // "no team" serves nothing at all and the bug is silent.
    state: () => ({ lane: 'advisory', soloLane: 'off', probe: found }),
    laneOf: makeLaneResolver({ teamLive: async () => false }),
    io: pushIo,
    onLoad: (row) => pushLedger.push(row),
  });
  // Exactly index.js's loader, including the stated teamLive.
  const wiredLoad = async (name, opts = {}) => {
    const options = { cwd: opts.cwd, teamLive: true };
    const catalog = await wiredProvider.list(options);
    const candidate = catalog.find(entry => entry.name === name);
    return candidate === undefined ? undefined : wiredProvider.get(candidate, options);
  };

  const wiredAppendix = await cePushAppendix({
    lane: 'full', role: 'driver', team: postGreen, cache: new Map(),
    probe: found, load: (name) => wiredLoad(name, { cwd: '/repo' }),
  });
  check(wiredAppendix !== '', 'the assembled push path actually produces an appendix');
  check(wiredAppendix.includes('BOUNDARY'), 'and the pushed body carries the ownership boundary, as the loader comment claims');
  check(wiredAppendix.includes('Look for duplication.'), 'with the CE text itself intact');
  check(pushLedger.length === 1 && pushLedger[0].teamLive === true, 'the pushed load is recorded as what it is: a load inside a live team');
  check(pushLedger[0].lane === 'advisory' && pushLedger[0].cwd === '/repo', 'attributed to the pair lane and the seat workspace, not to a solo session');

  // The regression itself: without the stated teamLive, the same wiring falls
  // through to a solo lane that is off, and pushes nothing while looking fine.
  const naiveLoad = async (name) => {
    const catalog = await wiredProvider.list({});
    const candidate = catalog.find(entry => entry.name === name);
    return candidate === undefined ? undefined : wiredProvider.get(candidate, {});
  };
  check(await naiveLoad('ce-simplify-code') === undefined, 'a loader that does not state the lane resolves to solo and serves nothing — the shape of the original bug');
}
