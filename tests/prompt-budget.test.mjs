/**
 * The usage section is paid on EVERY step of EVERY session that has this plugin installed,
 * whether or not it ever pairs. Its size is a budget, not a detail (issue #90).
 *
 * Measured 2026-09-11 - the section carries a different protocol text per mode, so one number
 * would hide the expensive one, and the two-contributor paragraph is charged only when that
 * experimental workflow is actually reachable:
 *
 *   solo   off 12,141 / on 13,302     (protocol  5,653 + rest 6,488)
 *   light  off 16,948 / on 18,109     (protocol 10,460 + rest 6,488)
 *   full   off 16,948 / on 18,109
 *
 * Re-measured 2026-09-12 after the tool list gained the three tools the prompt had been hiding
 * (pair_correction, pair_yield, pair_cleanup) and the captain protocol gained one sentence about
 * pair_correction: rest 6,445 -> 6,488 (+43, the tool names), protocol 10,366 -> 10,460 (+94, the
 * sentence). Both variants stay inside their budgets (solo 159 chars of headroom, light/full 152).
 *
 * The first version of this test pinned only `{}`, which resolves to the cheap solo variant -
 * it guarded the wrong one while a light/full deployment paid 4,700 more per step unwatched.
 */
import { readFileSync } from 'node:fs';
import { usageSectionText, fullUsageSectionText } from '../lib/prompt.js';
import { resolveConfig } from '../lib/defaults.js';
import { captainProtocol, soloProtocol } from '../lib/protocol/personas.js';

const BUDGET = { solo: 12300, light: 17100, full: 17100 };
const REST = 6488;
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
  /* ---- issue #90 item 2: the lean prompt, behind its flag ------------------ */
  // The risk of hiding the protocol is that nothing delivers it, or that the invariants stop
  // being standing instructions.
  // because the risk of moving the protocol to activation is that the hard invariants stop being
  // standing instructions. What moves is the PROCEDURE (re-readable at activation); what stays is
  // the law. Measured 2026-09-11: 1,256 chars, ~13x cheaper than the full section.
  const full = fullUsageSectionText({});
  const lean = usageSectionText({ experimentalLeanPrompt: true });
  check(lean.length < 1600,
    `the lean section is short (${lean.length} chars) but keeps the standing rules`);
  check(['ONE WRITER', 'ORACLE FIRST', 'TEST FIRST'].every(rule => lean.includes(rule)),
    'the lean section still states the invariants that must hold at every step (single writer, oracle first, test first)');
  check(!lean.includes(captainProtocol({})) && !lean.includes('Operating procedure'),
    'the lean section carries no protocol text and no operating procedure');
  check(lean.includes('pair_start'),
    'the lean section still tells the model HOW to activate - a trigger that does not name the call is not a trigger');
  check(full.length > 12000 && full.includes(captainProtocol({})),
    'the full text still exists and is what gets delivered at activation');
  check(resolveConfig({ experimentalLeanPrompt: true }).experimentalLeanPrompt === true,
    'a host can actually set the flag through the config path (declared in config.js and picked up by resolveConfig)');
  check(resolveConfig({}).experimentalLeanPrompt === false, 'and it defaults to off, so the shipped behaviour is byte-for-byte what it was');
  const lifecycleSrc = readFileSync(new URL('../lib/tools/lifecycle.js', import.meta.url), 'utf8');
  check(lifecycleSrc.includes('fullUsageSectionText') && lifecycleSrc.includes('config.experimentalLeanPrompt === true'),
    'the wiring exists: pair_start delivers the full protocol when the lean flag is on, so hiding it cannot lose it (this is a source check because the render is not reachable from a unit test, and a missing render would be invisible otherwise)');
}