/**
 * Observe CE skill loads that did NOT come through this plugin's provider.
 *
 * Why this exists, and why V5.3d was incomplete without it. The gate refuses a
 * credential when a skill that owns an execution or shipping loop was loaded
 * while the task was being built. But the ledger it reads was written only by
 * our own `provider.get()`, and our provider never serves those skills — so the
 * check could not fire on the one configuration it was written for: a user
 * pointing an ordinary skill root (`~/.agents/skills`, `~/.dsh/skills`, or
 * `customSkillDirs`) at a CE checkout. The rule was real; the observation was
 * looking in the wrong place.
 *
 * The right place is the tool pipeline. Every skill load, from every provider,
 * is a `skill` tool call, and `tools/pre-execute` sees all of them — the same
 * hook the board write guard already uses for the same reason: the decision
 * needs facts the synchronous guard surface cannot reach.
 *
 * This observer never denies a call. Loading a skill is not itself a protocol
 * violation; issuing a completion credential afterwards is, and that judgement
 * belongs to the gate with the whole board in front of it.
 *
 * @module dsh-pair-programming/integrations/ce-watch
 */
import { stateRootOf } from '../state/layout.js';
import { appendCeLoad } from './ce-ledger.js';
import { isCeSkill } from './ce-catalog.js';

/** The host tool every skill load goes through, whatever served the body. */
export const SKILL_TOOL_NAME = 'skill';

/**
 * Install the observer.
 *
 * @param {object} ctx - the plugin context (needs `ctx.on`).
 * @param {object} config - resolved config, for the state root.
 * @returns {Function} the disposer, or a no-op when the host has no waterfall.
 */
export function installCeLoadWatch(ctx, config) {
  if (typeof ctx.on !== 'function') return () => {};
  return ctx.on('tools/pre-execute', async (exec, next) => {
    // Cheapest possible check first: this listener runs on every tool call in
    // the process, and the overwhelming majority are not skill loads.
    if (exec?.name !== SKILL_TOOL_NAME) return next();
    const name = String(exec.arguments?.name ?? '').trim();
    if (name === '' || !isCeSkill(name)) return next();
    const workspace = exec.agent?.session?.header?.cwd;
    if (typeof workspace === 'string' && workspace !== '') {
      // Fire and forget: the audit line must never delay or fail a tool call.
      void appendCeLoad(stateRootOf(workspace, config), {
        name, at: Date.now(), via: 'skill-tool', cwd: workspace, agentId: exec.agent?.id,
      });
    }
    return next();
  });
}
