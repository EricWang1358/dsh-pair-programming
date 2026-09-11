/**
 * The usage section is paid on EVERY step of EVERY session that has this plugin installed,
 * whether or not it ever pairs. Its size is a budget, not a detail (issue #90).
 *
 * Measured 2026-09-11 - the section carries a different protocol text per mode, so one number
 * would hide the expensive one, and the two-contributor paragraph is charged only when that
 * experimental workflow is actually reachable:
 *
 *   solo   off 12,098 / on 13,259     (protocol  5,653 + rest 6,445)
 *   light  off 16,811 / on 17,972     (protocol 10,366 + rest 6,445)
 *   full   off 16,811 / on 17,972
 *
 * The first version of this test pinned only `{}`, which resolves to the cheap solo variant -
 * it guarded the wrong one while a light/full deployment paid 4,700 more per step unwatched.
 */
import { usageSectionText } from '../lib/prompt.js';
import { captainProtocol, soloProtocol } from '../lib/protocol/personas.js';

const BUDGET = { solo: 12300, light: 17100, full: 17100 };
const REST = 6445;
/** What enabling the two-contributor workflow costs, per step, for every session. */
const DUAL_DRIVER_PARAGRAPH = 1161;

export async function run(check) {
  const sizes = {};
  for (const mode of ['solo', 'light', 'full']) {
    const off = usageSectionText({ defaultMode: mode });
    sizes[mode] = off.length;
    check(off.length <= BUDGET[mode],
      `the ${mode} usage section stays inside its budget (${off.length} <= ${BUDGET[mode]}); every session pays it on every step (issue #90)`);
    const protocol = captainProtocol({ defaultMode: mode });
    check(off.split(protocol).length - 1 === 1, `the ${mode} section carries the protocol text exactly once`);
    check(off.length - protocol.length === REST,
      `the ${mode} non-protocol text is mode-independent (${off.length - protocol.length} chars)`);
    // An experimental path that is not configured must not be described, let alone paid for.
    check(!off.includes('Optional two-contributor workflow'),
      `the ${mode} section does not advertise the two-contributor workflow while it is off - the feature is unreachable and the text was 1,161 chars of every step`);
    const on = usageSectionText({ defaultMode: mode, experimentalDualDrivers: true });
    check(on.includes('Optional two-contributor workflow'), `the ${mode} section describes it once the workflow is enabled`);
    check(on.length - off.length === DUAL_DRIVER_PARAGRAPH,
      `enabling the two-contributor workflow costs exactly ${DUAL_DRIVER_PARAGRAPH} chars per step (measured ${on.length - off.length})`);
    check(usageSectionText({ defaultMode: mode, dualDriverIntegrationCommand: 'npm test' }).includes('Optional two-contributor workflow'),
      'a configured integration command also makes the workflow reachable, so the paragraph appears for it too');
  }
  check(soloProtocol({}) === captainProtocol({}), 'captainProtocol with no mode falls back to soloProtocol; if that changes, revisit the composition');
  check(sizes.light >= sizes.solo, 'the light/full section is the expensive one, and it is the mode most deployments configure');
  const ceOff = usageSectionText({ ceLanes: 'off', ceSoloLane: 'off' }).length;
  const ceOn = usageSectionText({ ceLanes: 'advisory' }).length;
  check(ceOn > ceOff, 'the CE paragraph is charged only when a lane is on - the scenario pricing this plugin does apply');
  check(true, `composition: solo ${sizes.solo} / light ${sizes.light} / full ${sizes.full}; two-contributor +${DUAL_DRIVER_PARAGRAPH}; CE +${ceOn - ceOff}`);
}