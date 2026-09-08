/**
 * Claims about the plugin that live outside the plugin's code.
 *
 * A version string in `package.json` and a count in an architecture diagram
 * are assertions like any other; they are just not executed, so nothing tells
 * anyone when they stop being true. The 2026-09-05 review found three that had
 * already rotted: `dsh.sdk.testedCohort` named alpha.5 while every installed
 * package was rc.1, ARCHITECTURE.md said twenty tools while the registry had
 * twenty-two, and it named PROTOCOL_VERSION=4 while personas shipped '5'.
 *
 * None of those was dangerous on its own. Together they are the reason a
 * reader cannot use the documents to check the code — which is the whole point
 * of having them. So the few numbers that are cheap to derive are derived here
 * and compared, and nothing else is pinned: a suite that mirrored every
 * sentence would become the second source of truth it exists to prevent.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel) => readFile(root(rel), 'utf8');

/** Packages whose installed version the tested-cohort string speaks for. */
const COHORT_PACKAGES = [
  'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-settings', 'dsh-subagent', 'dsh-tools',
];

export async function run(check) {
  const manifest = JSON.parse(await read('package.json'));

  /* ---- the tested cohort names what is actually installed ---------------- */
  const installed = new Map();
  for (const name of COHORT_PACKAGES) {
    try {
      installed.set(name, JSON.parse(await read(`node_modules/@deepseek-ai/${name}/package.json`)).version);
    } catch { /* not installed here; see the skip below */ }
  }
  if (installed.size === 0) {
    check(true, 'no SDK installed beside the package — the cohort check is a no-op outside a prepared checkout');
  } else {
    const versions = new Set(installed.values());
    check(versions.size === 1,
      `every installed @deepseek-ai package should be one cohort, found ${[...installed].map(([k, v]) => `${k}@${v}`).join(', ')}`);
    const cohort = manifest.dsh?.sdk?.testedCohort ?? '';
    for (const version of versions) {
      check(cohort.includes(version),
        `dsh.sdk.testedCohort ("${cohort}") should name the installed version ${version} — it is the claim that a startup verification actually ran against this cohort`);
    }
  }

  /* ---- the config schema and its published types agree ------------------- */
  const { Config } = await import('../lib/config.js');
  const schemaKeys = Object.keys(Config?.dict ?? {});
  const types = await read('lib/types/index.d.ts');
  const start = types.indexOf('export interface Config');
  const block = types.slice(start, types.indexOf('}', start));
  const declared = [...block.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*)\??:/gm)].map(m => m[1]);
  check(schemaKeys.length > 0, 'the config schema should expose its keys');
  const missing = schemaKeys.filter(k => !declared.includes(k));
  const extra = declared.filter(k => !schemaKeys.includes(k));
  check(missing.length === 0, `every config key needs a type declaration; missing: ${missing.join(', ')}`);
  check(extra.length === 0, `every declared config field needs a schema key; stale: ${extra.join(', ')}`);

  /* ---- the architecture document's two derivable numbers ----------------- */
  const architecture = await read('docs/02-architecture/ARCHITECTURE.md');

  const toolNames = new Set();
  for (const file of ['arbitrate', 'flow', 'gate-exec', 'integrate', 'lifecycle', 'mailbox', 'oracle', 'oracle-exec', 'risk', 'task']) {
    for (const match of (await read(`lib/tools/${file}.js`)).matchAll(/name: *'(pair_[a-z_]+)'/g)) {
      toolNames.add(match[1]);
    }
  }
  check(toolNames.size > 0, 'the tool modules should declare pair_* tools');
  const claimedCounts = [...architecture.matchAll(/(\d+) 个 `?pair_\*/g)].map(m => Number(m[1]));
  check(claimedCounts.length > 0, 'ARCHITECTURE.md should state a tool count');
  for (const claimed of claimedCounts) {
    check(claimed === toolNames.size,
      `ARCHITECTURE.md claims ${claimed} pair_* tools, the modules declare ${toolNames.size}`);
  }

  const { PROTOCOL_VERSION } = await import('../lib/protocol/personas.js');
  const claimedProtocol = architecture.match(/当前协议为 PROTOCOL_VERSION=(\d+)/)?.[1];
  check(claimedProtocol !== undefined, 'ARCHITECTURE.md should state the current PROTOCOL_VERSION');
  check(claimedProtocol === String(PROTOCOL_VERSION),
    `ARCHITECTURE.md claims PROTOCOL_VERSION=${claimedProtocol}, personas ship '${PROTOCOL_VERSION}'`);

  /* ---- the changelog's top entry matches the version being shipped ------- */
  const changelog = await read('CHANGELOG.md');
  const topRelease = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  check(topRelease === manifest.version,
    `the newest CHANGELOG entry is ${topRelease}, package.json ships ${manifest.version}`);
}
