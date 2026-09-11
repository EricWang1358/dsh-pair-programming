/**
 * The usage section is paid on EVERY step of EVERY session that has this plugin installed,
 * whether or not it ever pairs. Its size is therefore a budget, not a detail (issue #90).
 *
 * Measured 2026-09-11, per defaultMode - the section carries a different protocol text per
 * mode, so a single number hides the expensive one:
 *
 *   solo   13,257  (protocol  5,653 + rest 7,604)   <- DEFAULTS.defaultMode
 *   light  17,970  (protocol 10,366 + rest 7,604)
 *   full   17,970  (protocol 10,366 + rest 7,604)
 *
 * The first version of this test pinned only `{}`, which resolves to solo - it guarded the
 * cheap variant while a deployment configured to light or full paid 4,700 more chars per step
 * with nothing watching. Per-mode budgets are what that mistake taught.
 *
 * Raising a budget is allowed; doing it without noticing is not.
 */
import { usageSectionText } from '../lib/prompt.js';
import { captainProtocol, soloProtocol } from '../lib/protocol/personas.js';

const BUDGET = { solo: 13600, light: 18400, full: 18400 };
const REST = 7604;

export async function run(check) {
  const sizes = {};
  for (const mode of ['solo', 'light', 'full']) {
    const text = usageSectionText({ defaultMode: mode });
    sizes[mode] = text.length;
    check(text.length <= BUDGET[mode],
      `the ${mode} usage section stays inside its budget (${text.length} <= ${BUDGET[mode]}); every session pays it on every step (issue #90)`);
    const protocol = captainProtocol({ defaultMode: mode });
    check(text.split(protocol).length - 1 === 1, `the ${mode} section carries the protocol text exactly once`);
    check(sizes[mode] - protocol.length === REST,
      `the ${mode} non-protocol text is mode-independent (${sizes[mode] - protocol.length} chars: trigger line, operating procedure, mode notes, tool list)`);
  }
  check(soloProtocol({}) === captainProtocol({}),
    'captainProtocol with no mode falls back to soloProtocol; if that changes, revisit the composition');
  check(sizes.light >= sizes.solo, 'the light/full section is the expensive one, and it is the mode most deployments configure');
  const off = usageSectionText({ ceLanes: 'off', ceSoloLane: 'off' }).length;
  const on = usageSectionText({ ceLanes: 'advisory' }).length;
  check(on > off, 'the CE paragraph is paid only when a lane is on - the one place this plugin already charges by scenario');
  check(true, `composition: solo ${sizes.solo} / light ${sizes.light} / full ${sizes.full}; CE adds ${on - off}`);
}