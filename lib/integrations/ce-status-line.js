/**
 * One board-visible line about the Compound Engineering lane.
 *
 * It belongs on the board rather than only in Settings because the lane
 * changes what a seat can load mid-cycle, and anything that changes what a
 * seat can do is protocol state a captain must be able to read without leaving
 * the tool surface. The cost is stated in the same line as the lane: a model
 * catalog is repeated input on every step, and this integration's own
 * measurement gate says no lane is turned on by default until an A/B on one
 * frozen oracle shows it earns that.
 *
 * @module dsh-pair-programming/integrations/ce-status-line
 */
import { catalogCost, soloCatalogCost } from './ce-catalog.js';
import { probeSummary } from './ce-probe.js';

/**
 * @param {object} config - the plugin's resolved config; `ceProbe` is filled
 *   in by the host wiring after each probe and is absent in library use.
 */
export function ceStatusLine(config = {}) {
  const lane = config.ceLanes ?? 'off';
  const solo = config.ceSoloLane ?? 'off';
  // Declared before the early return below: the off-lane branch reports the ledger too,
  // because a violation can have been recorded while the lane was still armed.
  const loads = config.ceLoads;
  const soloNote = solo === 'off'
    ? 'Without a live team this workspace sees no CE skills.'
    : `Without a live team it widens to the "${solo}" lane (${soloCatalogCost(solo).skills} in the model catalog, ~${soloCatalogCost(solo).approxTokens} tokens/step).`;
  if (lane === 'off') return `CE lane: off while this team is live — no Compound Engineering skills are exposed to any seat and none are billed. ${soloNote} ${loads === undefined ? 'Loads: not read in this process.' : loads.readable === false ? 'Loads: ledger UNREADABLE - treat as unknown.' : `Loads during this team: ${(loads.loads ?? []).length}${loads.violation?.ok === false ? ' - LANE VIOLATION: ' + loads.violation.reason : ''}`}`;
  const cost = catalogCost(lane);
  const detection = config.ceProbe === undefined
    ? 'no probe has run in this process'
    : probeSummary(config.ceProbe);
  const catalog = cost.skills === 0
    ? 'nothing enters the model catalog (user-gesture skills only, zero repeated tokens)'
    : `${cost.skills} skill(s) in the model catalog, ~${cost.approxTokens} repeated tokens per step`;
  // What the GATE acts on must also be legible on the board. The ledger records skill loads
  // per task window, and a shipping-lane load blocks the credential (ce-ledger.js) - so a
  // refusal with no line here is a blind spot, not silence.
  const ledger = loads === undefined
    ? 'Loads: not read in this process.'
    : loads.readable === false
      ? 'Loads: ledger UNREADABLE - treat as unknown, never as "nothing was loaded".'
      : (() => {
        const entries = loads.loads ?? [];
        const names = [...new Set(entries.map(entry => entry.name))].slice(0, 3).join(', ');
        const count = `Loads during this team: ${entries.length}${names ? ' (' + names + ')' : ''}`;
        return loads.violation?.ok === false
          ? `${count} - LANE VIOLATION: ${loads.violation.reason}`
          : count;
      })();
  return `CE lane: ${lane} while this team is live — ${catalog}. ${soloNote} Detection: ${detection}. ${ledger}`
    + ' Inside a team CE is advisory: the pair protocol owns every write, and the execution/commit/PR skills are not served at all.';
}
