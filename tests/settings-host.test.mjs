/**
 * Both settings namespaces against the REAL file-backed provider.
 *
 * `settings.test.mjs` drives a hand-written stub, which can only confirm that
 * we call `installSection` — never that the schema resolves, that the base
 * layer is accepted, that the namespace grammar passes, or that a write round
 * trips. Those are the host's rules, and the host is the only thing that knows
 * them. This is the same gap that let a CE provider ship for four releases with
 * a candidate the registry rejects on sight.
 *
 * It also pins the derived-namespace pattern the CE probe and the navigator
 * route test both depend on: a second, host-written namespace registered by the
 * same plugin, which the card reads but never edits.
 *
 * The provider keeps a file watcher, so the fork is disposed at the end —
 * without that this suite would hold the runner open forever, which is exactly
 * how the throwaway probe that motivated this file ended up running for hours.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file';
import { installPairSettings, SETTINGS_NAMESPACE, PairSettingsSchema } from '../lib/settings.js';
import { installCeStatus, CE_STATUS_NAMESPACE } from '../lib/integrations/ce-install.js';
import { resolveConfig } from '../lib/defaults.js';

export async function run(check) {
  const dir = await mkdtemp(join(tmpdir(), 'pair-settings-host-'));
  const file = join(dir, 'settings.yaml');
  const ctx = new Context();
  const fork = ctx.plugin(FileSettingsProvider, { path: file });
  await new Promise((resolve) => setTimeout(resolve, 120));

  try {
    check(typeof ctx.settings === 'object' && typeof ctx.settings.installSection === 'function',
      'the real file-backed settings provider mounts');

    /* ---- the plugin's own section, as the host resolves it -------------- */
    const resolved = resolveConfig({ navigatorModel: 'deepseek/deepseek-reasoner', maxCyclesPerTask: 7 });
    let installError;
    try {
      installPairSettings(ctx.settings, ctx, resolved, '');
    } catch (error) {
      installError = String(error?.message ?? error);
    }
    check(installError === undefined,
      `installPairSettings is accepted by the real service${installError === undefined ? '' : ` — threw: ${installError}`}`);

    const described = ctx.settings.describe({ redactSecrets: true });
    const section = described.find((d) => d.ns === SETTINGS_NAMESPACE);
    check(section !== undefined, 'the namespace name passes the host grammar and appears in describe()');
    check(section.value.maxCyclesPerTask === 7,
      'a composed value reaches the resolved snapshot through the base layer — the drift that made navigatorModel a no-op in YAML');
    check(section.value.navigatorModel === 'deepseek/deepseek-reasoner',
      'including the field that drift actually bit');
    check(section.value.tddMode === resolved.tddMode, 'and untouched fields resolve to the composed value, not to a schema guess');

    /* ---- a write round-trips through the real provider ------------------ */
    // Captured BEFORE the write: `resolved` is the plugin's live runtime object
    // and follows every commit, so after the write it no longer holds the
    // composed value the base layer keeps.
    const composedTddMode = resolved.tddMode;
    await ctx.settings.update(SETTINGS_NAMESPACE, { tddMode: 'coach' });
    const afterWrite = ctx.settings.describe().find((d) => d.ns === SETTINGS_NAMESPACE);
    check(afterWrite.value.tddMode === 'coach', 'a user-layer write commits');
    check(afterWrite.user.tddMode === 'coach' && afterWrite.base.tddMode === composedTddMode,
      'and lands in the USER layer with the composed base intact — which is what makes "reset" mean anything');
    check(resolved.tddMode === 'coach', 'the plugin runtime object follows the commit, so the next tool call reads the new value');

    const persisted = await readFile(file, 'utf8');
    check(persisted.includes('coach'), 'the provider actually wrote it to disk');

    /* ---- the host rejects what the plugin says it should ---------------- */
    let refused;
    try {
      await ctx.settings.update(SETTINGS_NAMESPACE, { tddMode: 'nonsense' });
    } catch (error) {
      refused = String(error?.message ?? error);
    }
    check(refused !== undefined && refused.includes('tddMode'),
      'the plugin validator runs inside the host write path — an invalid value is refused before it persists, not after');

    let refusedCommand;
    try {
      await ctx.settings.update(SETTINGS_NAMESPACE, { dodCommand: 'the suite must stay green' });
    } catch (error) {
      refusedCommand = String(error?.message ?? error);
    }
    check(refusedCommand !== undefined,
      'and the command-shape rule reaches the settings boundary, so prose cannot become a red gate later');

    /* ---- the derived namespace the cards read --------------------------- */
    let ceError;
    try {
      installCeStatus(ctx.settings, resolved, { probe: async () => ({ status: 'not-found', probedAt: 1 }) });
    } catch (error) {
      ceError = String(error?.message ?? error);
    }
    check(ceError === undefined, `the derived CE namespace registers alongside the config one${ceError === undefined ? '' : ` — threw: ${ceError}`}`);
    const both = ctx.settings.describe().map((d) => d.ns);
    check(both.includes(SETTINGS_NAMESPACE) && both.includes(CE_STATUS_NAMESPACE),
      'both namespaces coexist — probe output stays out of the section a human hand-edits');

    // Fields carrying a default must always resolve; an optional one (dodCommand
    // has no default) is legitimately absent until somebody sets it.
    const declared = Object.keys(PairSettingsSchema.dict ?? {});
    const withDefaults = Object.keys(PairSettingsSchema({}));
    const missing = withDefaults.filter((f) => !(f in section.value));
    check(missing.length === 0,
      `every field the schema gives a default resolves at runtime (missing: ${missing.join(', ') || 'none'})`);
    const unexpected = Object.keys(section.value).filter((f) => !declared.includes(f));
    check(unexpected.length === 0,
      `and nothing resolves that the schema never declared (unexpected: ${unexpected.join(', ') || 'none'})`);
  } finally {
    // Without this the file watcher holds the runner open — the failure mode
    // that turned the throwaway version of this probe into a task that ran for
    // hours before anyone noticed.
    await fork?.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
}
