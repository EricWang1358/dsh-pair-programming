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
  const rt = toRuntimeSettings({ tddMode: 'coach', pairStyle: 'ping-pong', defaultMode: 'light', maxCyclesPerTask: 6, spikeMaxCycles: 1, greenBuildOnStop: false, dod: 'all_accepted,test_first' });
  check(rt.tddMode === 'coach' && rt.pairStyle === 'ping-pong' && rt.maxCyclesPerTask === 6 && rt.greenBuildOnStop === false, 'toRuntimeSettings copies scalars');
  check(Array.isArray(rt.dod) && rt.dod.length === 2, 'toRuntimeSettings parses dod to array');
  check(toRuntimeSettings({ tddMode: 'weird' }).tddMode === 'enforce', 'toRuntimeSettings fails safe on unknown enum');

  // validate rejects nonsense beyond the schema (string enums, budgets, dod names)
  check(settingsValueError({ tddMode: 'enforce', pairStyle: 'strong', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, greenBuildOnStop: true, dod: 'test_first' }) === undefined, 'validate accepts a sane section');
  check(String(settingsValueError({ tddMode: 'yolo', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, greenBuildOnStop: true, dod: '' })).includes('tddMode'), 'validate rejects bad tddMode');
  check(String(settingsValueError({ tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 0, spikeMaxCycles: 2, greenBuildOnStop: true, dod: '' })).includes('maxCyclesPerTask'), 'validate rejects zero budget');
  check(String(settingsValueError({ tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, spikeMaxCycles: 2, greenBuildOnStop: true, dod: 'made_up_item' })).includes('made_up_item'), 'validate rejects unknown DoD item');

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
}
