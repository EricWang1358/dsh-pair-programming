import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLifecycleTools } from '../lib/tools/lifecycle.js';
export async function run(check) {
  const root = await mkdtemp(join(tmpdir(), 'pair-dual-start-'));
  const defs = [];
  const ctx = { tools: { register: d => defs.push(d) }, logger: { warn() {} },
    llm: { resolveCallConfig: async v => v }, subagents: { getProvider() {}, list: () => [] } };
  const agent = { id: 'captain', options: { provider: 'test', model: 'test' }, session: { header: { cwd: root }, requestHeader() {} } };
  registerLifecycleTools(ctx, { stateDir: '.pair-programming', defaultMode: 'solo' }, { scheduler: {}, selections: {} });
  try {
    const use_cases = [{ actor: 'developer', intent: 'repair two functions', outcome: 'preserve existing contracts', acceptance_criteria: ['both functions repaired'] }];
    for (const [extra, pattern] of [[{ drivers: 3 }, /drivers must/], [{ drivers: 2, mode: 'solo' }, /two Drivers require light/], [{ drivers: 2 }, /integration_command/], [{ drivers: 2, integration_command: 'node regression.cjs' }, /git|repository/i]]) {
      let message = '';
      try { await defs.find(d => d.name === 'pair_start').execute({ goal: 'test', name: 'test', use_cases, ...extra }, { agent }); }
      catch (error) { message = error.message; }
      check(pattern.test(message), `dual start preflight ${JSON.stringify(extra)}: ${message}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
