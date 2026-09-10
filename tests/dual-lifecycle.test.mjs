import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLifecycleTools, resolveStartComposition } from '../lib/tools/lifecycle.js';
import { execFileSync } from 'node:child_process';
import { requireDriverCheckpoint } from '../lib/runtime/worktrees.js';
export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-dual-start-'));
  const defs = [];
  const ctx = { tools: { register: d => defs.push(d) }, logger: { warn() {} },
    llm: { resolveCallConfig: async v => v }, subagents: { getProvider() {}, list: () => [] } };
  const agent = { id: 'captain', options: { provider: 'test', model: 'test' }, session: { header: { cwd: root }, requestHeader() {} } };
  registerLifecycleTools(ctx, { stateDir: '.pair-programming', defaultMode: 'solo' }, { scheduler: {}, selections: {} });
  try {
    const use_cases = [{ actor: 'developer', intent: 'repair two functions', outcome: 'preserve existing contracts', acceptance_criteria: ['both functions repaired'] }];
    for (const [extra, pattern] of [[{ drivers: 3 }, /drivers must/], [{ drivers: 2, mode: 'solo' }, /two Drivers require light/], [{ drivers: 2 }, /integration_command/]]) {
      let message = '';
      try { await defs.find(d => d.name === 'pair_start').execute({ goal: 'test', name: 'test', use_cases, ...extra }, { agent }); }
      catch (error) { message = error.message; }
      check(pattern.test(message), `dual start preflight ${JSON.stringify(extra)}: ${message}`);
    }
    let prerequisite;
    try { await defs.find(d => d.name === 'pair_start').execute({ goal:'test', name:'test', use_cases, drivers:2, integration_command:'node test.mjs' }, {agent}); }
    catch(error) { prerequisite=error; }
    check(prerequisite?.code === 'PAIR_GIT_CHECKPOINT_REQUIRED' && prerequisite.message.includes('explicit approval'), 'non-Git dual start asks Captain to propose a user-approved checkpoint');
    for (const path of ['.git','.pair-programming/test']) {
      let exists=true; try {await access(join(root,path));}catch{exists=false;}
      check(!exists, 'preflight does not create '+path);
    }
    execFileSync('git',['init'],{cwd:root,stdio:'ignore'});
    let unborn;try{await requireDriverCheckpoint(root);}catch(error){unborn=error;}
    check(unborn?.code==='PAIR_GIT_CHECKPOINT_REQUIRED', 'Git without HEAD requests an approved baseline commit');
    await writeFile(join(root,'baseline.txt'),'checkpoint');
    execFileSync('git',['add','baseline.txt'],{cwd:root,stdio:'ignore'});
    execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','-m','approved fixture checkpoint'],{cwd:root,stdio:'ignore'});
    check(await requireDriverCheckpoint(root)===root, 'committed checkpoint passes read-only dual prerequisite');
    const automatic = resolveStartComposition({}, { defaultMode: 'solo', experimentalDualDrivers: true, dualDriverIntegrationCommand: 'node regression.cjs' });
    check(automatic.drivers === 2 && automatic.mode === 'light' && automatic.integrationCommand === 'node regression.cjs', 'a ready experimental setting selects two Drivers, light mode, and its saved command when drivers is omitted');
    const incomplete = resolveStartComposition({}, { defaultMode: 'solo', experimentalDualDrivers: true, dualDriverIntegrationCommand: '' });
    check(incomplete.drivers === 1 && incomplete.mode === 'solo', 'an incomplete experiment stays inert so ordinary starts keep their configured shape');
    const explicitSingle = resolveStartComposition({ drivers: 1 }, { defaultMode: 'light', experimentalDualDrivers: true, dualDriverIntegrationCommand: 'node regression.cjs' });
    check(explicitSingle.drivers === 1 && explicitSingle.mode === 'light', 'an explicit single-Driver request overrides the experimental default');
  } finally { await rm(root, { recursive: true, force: true }); }
}
