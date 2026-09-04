import { readFile } from 'node:fs/promises';
import { DEFAULTS, TDD_MODES, PAIR_STYLES, TEAM_MODES, MEMBER_LIFETIMES, CE_LANES } from '../lib/defaults.js';
/** settings surface: schema mapping, validation, and live-override plumbing. */
import { PairSettingsSchema, SETTINGS_NAMESPACE, parseDod, toRuntimeSettings, settingsValueError, settingsEntry, installPairSettings } from '../lib/settings.js';

/** Minimal stand-in for the host settings service with provider semantics. */
function fakeSettingsProvider() {
  const registered = new Map();
  return {
    registered,
    installSection(owner, ns, schema, entry, hooks) {
      registered.set(ns, { schema, entry, hooks });
      // attach: authority is the resolved scope (here: base+user layering)
      const user = {};
      const current = () => ({ ...entry, ...user });
      hooks.setSource(current);
      return { commit(patch) { Object.assign(user, patch); hooks.setSource(current); hooks.onChange(); } };
    },
  };
}

export async function run(check) {
  check(SETTINGS_NAMESPACE === 'pair-programming', 'namespace is lowercase-hyphenated pair-programming');

  // parseDod: comma list -> array, empty -> undefined
  const arr = parseDod('test_first, all_accepted ,,spike_outcome');
  check(Array.isArray(arr) && arr.length === 3 && arr[1] === 'all_accepted', 'parseDod trims and drops empties');
  check(parseDod('  ') === undefined && parseDod(undefined) === undefined, 'parseDod empty -> undefined (protocol defaults)');

  // toRuntimeSettings maps to the runtime shapes consumers read
  const rt = toRuntimeSettings({ tddMode: 'coach', pairStyle: 'ping-pong', defaultMode: 'light', maxCyclesPerTask: 6, spikeMaxCycles: 1, maxOpenRisks: 3, greenBuildOnStop: false, dod: 'all_accepted,test_first' });
  check(rt.tddMode === 'coach' && rt.pairStyle === 'ping-pong' && rt.maxCyclesPerTask === 6 && rt.greenBuildOnStop === false, 'toRuntimeSettings copies scalars');
  check(Array.isArray(rt.dod) && rt.dod.length === 2, 'toRuntimeSettings parses dod to array');
  check(toRuntimeSettings({ tddMode: 'weird' }).tddMode === 'enforce', 'toRuntimeSettings fails safe on unknown enum');

  // validate rejects nonsense beyond the schema (string enums, budgets, dod names)
  check(settingsValueError({ tddMode: 'enforce', pairStyle: 'strong', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, planningMaxArbitrations: 2, maxOpenRisks: 15, greenBuildOnStop: true, dod: 'test_first' }) === undefined, 'validate accepts a sane section');
  check(String(settingsValueError({ tddMode: 'yolo', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, greenBuildOnStop: true, dod: '' })).includes('tddMode'), 'validate rejects bad tddMode');
  check(String(settingsValueError({ tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 0, spikeMaxCycles: 2, greenBuildOnStop: true, dod: '' })).includes('maxCyclesPerTask'), 'validate rejects zero budget');
  check(String(settingsValueError({ tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, planningMaxArbitrations: 2, maxOpenRisks: 15, greenBuildOnStop: true, dod: 'made_up_item' })).includes('made_up_item'), 'validate rejects unknown DoD item');

  // the raise budget is a hot field: validated and carried like its siblings.
  const okSettings = { tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, maxOpenRisks: 15, planningMaxArbitrations: 2, greenBuildOnStop: true, dod: '' };
  check(settingsValueError(okSettings) === undefined, 'a settings value carrying the budget validates');
  check([0, 2.5, 'big'].every(bad => String(settingsValueError({ ...okSettings, maxOpenRisks: bad })).includes('maxOpenRisks must be an integer >= 1')), 'the settings face rejects a 0 or fractional budget');
  check(toRuntimeSettings(okSettings).maxOpenRisks === 15, 'toRuntimeSettings carries the raise budget');
  check(PairSettingsSchema({}).maxOpenRisks === 15, 'section schema defaults maxOpenRisks to 15');
  check([0, 1.5, 'two'].every(bad => String(settingsValueError({ ...okSettings, planningMaxArbitrations: bad })).includes('planningMaxArbitrations must be an integer >= 1')), 'the planning cap refuses 0 and non-integers');
  check(toRuntimeSettings(okSettings).planningMaxArbitrations === 2 && PairSettingsSchema({}).planningMaxArbitrations === 2, 'the planning cap defaults to 2 and reaches the runtime shape');
  // dodCommand (M7'): optional string, off by default, carried like its siblings.
  check(settingsValueError({ ...okSettings, dodCommand: 'node tests/run.mjs' }) === undefined, 'a sane dodCommand validates');
  check([42, {}, true].every(bad => String(settingsValueError({ ...okSettings, dodCommand: bad })).includes('dodCommand')), 'the settings face rejects a non-string dodCommand');
  check(toRuntimeSettings({ ...okSettings, dodCommand: 'node tests/run.mjs' }).dodCommand === 'node tests/run.mjs', 'toRuntimeSettings carries dodCommand');
  check(PairSettingsSchema({}).dodCommand === undefined, 'section schema leaves dodCommand unset by default');

  // settingsEntry: base layer mirrors the composed YAML, dod raw string preserved
  const resolved = { tddMode: 'off', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, greenBuildOnStop: true, dod: undefined, stateDir: '.pair-programming', slashCommand: true };
  const entry = settingsEntry(resolved, 'all_accepted');
  check(entry.tddMode === 'off' && entry.dod === 'all_accepted', 'settingsEntry captures the composed base (incl. raw dod)');

  // full install lifecycle: attach -> commit -> values flip in the mutable resolved object
  const provider = fakeSettingsProvider();
  installPairSettings(provider, { id: 'plugin:pair-programming' }, resolved, 'all_accepted');
  check(provider.registered.has(SETTINGS_NAMESPACE), 'installSection registered the namespace');
  check(resolved.tddMode === 'off' && Array.isArray(resolved.dod) && resolved.dod[0] === 'all_accepted', 'attach keeps composed values in resolved');
  // simulate a user override commit (Settings UI / settings.yaml hot reload)
  const scope = provider.registered.get(SETTINGS_NAMESPACE);
  scope.hooks.setSource(() => ({ ...entry, tddMode: 'enforce', maxCyclesPerTask: 8, dod: 'all_accepted,test_first' }));
  scope.hooks.onChange();
  check(resolved.tddMode === 'enforce' && resolved.maxCyclesPerTask === 8 && resolved.dod.includes('test_first'), 'committed override flips resolved in place');
  check(resolved.stateDir === '.pair-programming', 'YAML-only fields untouched by the override');
  // the section schema accepts the entry shape and fills defaults from {}
  const viaSchema = PairSettingsSchema({});
  check(viaSchema.tddMode === 'enforce' && viaSchema.maxCyclesPerTask === 12 && viaSchema.greenBuildOnStop === true && viaSchema.dod === '', 'section schema defaults match the runtime defaults');
  check(PairSettingsSchema(entry).tddMode === 'off', 'section schema accepts the composed entry');

  // The browser card is served verbatim as a classic script, so it cannot
  // import lib/defaults.js — it mirrors those literals. Pin the mirror: a
  // divergence must fail here rather than ship a dropdown that disagrees with
  // what the plugin honours (the exact shape of the original defaultMode bug).
  const clientSrc = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const clientArray = (name) => JSON.parse(clientSrc.match(new RegExp('var ' + name + ' = (\\[[^\\]]*\\]);'))[1].split("'").join('"'));
  check(JSON.stringify(clientArray('TDD_MODES')) === JSON.stringify(TDD_MODES), 'client TDD_MODES mirrors lib/defaults.js');
  check(JSON.stringify(clientArray('PAIR_STYLES')) === JSON.stringify(PAIR_STYLES), 'client PAIR_STYLES mirrors lib/defaults.js');
  check(JSON.stringify(clientArray('TEAM_MODES')) === JSON.stringify(TEAM_MODES), 'client TEAM_MODES mirrors lib/defaults.js');
  check(JSON.stringify(clientArray('MEMBER_LIFETIMES')) === JSON.stringify(MEMBER_LIFETIMES), 'client MEMBER_LIFETIMES mirrors lib/defaults.js');
  check(JSON.stringify(clientArray('CE_LANES')) === JSON.stringify(CE_LANES), 'client CE_LANES mirrors lib/defaults.js');
  // Every field the plugin serves must be renderable, or the UI silently hides
  // a knob the runtime obeys.
  const served = Object.keys(PairSettingsSchema({}));
  const missingInCard = served.filter((f) => !clientSrc.includes(`bind('${f}')`));
  check(missingInCard.length === 0, `every served setting has a card row (missing: ${missingInCard.join(', ') || 'none'})`);
  // Assert the wiring, not the value. Pinning the literal here made this test
  // fail on a deliberate default change, which teaches people to edit the
  // test rather than to check the wiring it exists to protect.
  check(PairSettingsSchema({}).defaultMode === DEFAULTS.defaultMode, 'the settings schema default comes from lib/defaults.js, not a restated literal');
  check(TEAM_MODES.includes(DEFAULTS.defaultMode), 'the default mode is one the settings surface can actually offer');
}
