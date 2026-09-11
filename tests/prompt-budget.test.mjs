/**
 * The usage section is paid on EVERY step of EVERY session that has this plugin installed,
 * whether or not it ever pairs. That makes its size a budget rather than a detail - and
 * until this suite existed nothing measured it (issue #90).
 *
 * The precedent is the CE catalog: it enforces a 110-character per-line budget and that
 * budget caught a 168-character line the same afternoon it was written. The plugin asked CE
 * for an A/B before paying 7.5K chars per step while paying 13.3K of its own unconditionally.
 *
 * Raising BUDGET is allowed; doing it without noticing is not. If you raise it, say what the
 * extra text buys and update the number here.
 */
import { usageSectionText } from '../lib/prompt.js';
import { captainProtocol, soloProtocol } from '../lib/protocol/personas.js';

/** Measured 2026-09-11: usageSectionText({}) = 13,257 chars. */
const BUDGET = 13600;

export async function run(check) {
  const base = usageSectionText({});
  const protocol = captainProtocol({});
  check(base.length <= BUDGET,
    `the usage section stays inside its per-step budget (${base.length} <= ${BUDGET}); it is paid by every session on every step (issue #90)`);
  check(protocol.length > 0 && base.includes(protocol), 'the captain protocol is what the section is for');
  check(base.split(protocol).length - 1 === 1,
    'the protocol text appears exactly once - a second copy would be paid on every step');
  check(soloProtocol({}) === captainProtocol({}),
    'captainProtocol and soloProtocol are byte-identical today; if they ever diverge, revisit the section composition (issue #90)');
  const off = usageSectionText({ ceLanes: 'off', ceSoloLane: 'off' }).length;
  const on = usageSectionText({ ceLanes: 'advisory' }).length;
  check(on > off,
    'the CE paragraph is paid only when a lane is on - the one place this plugin already charges by scenario');
  check(true,
    `composition: total ${base.length} = protocol ${protocol.length} + rest ${base.length - protocol.length}; CE off=${off} on=${on}`);
}