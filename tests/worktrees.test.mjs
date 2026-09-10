import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, lstatSync, symlinkSync } from 'node:fs';
import { digestOracleFiles } from '../lib/tools/oracle-exec.js';
import { resolveStartComposition } from '../lib/tools/lifecycle.js';
import { createDriverWorktrees, snapshotCandidate, integrateCandidate, removeDriverWorktrees, scopeConflicts } from '../lib/runtime/worktrees.js';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pair-worktrees-'));
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Worktree test');
  await git(root, 'config', 'user.email', 'worktree@test.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'a.txt'), 'A\n');
  await writeFile(join(root, 'b.txt'), 'B\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'base');
  return root;
}
export async function run(check) {
  const test = async (name, fn) => {
    const root = await fixture();
    try { await fn(root); check(true, name); }
    catch (error) { check(false, `${name}: ${error.stack}`); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };
  const create = root => createDriverWorktrees(root, join(root, '.pair-programming'), 'team');
  /* ---- A3 (#7): the disposable integration checkout is a Git worktree ----
   * A worktree materialises TRACKED files only, so an app whose runtime data is
   * gitignored (data/jobs.json) has an incomplete environment there: its oracles
   * print PREREQ and its suite exits through an instrument marker, and BOTH read
   * as a bad candidate. Seeding is therefore opt-in per run — anything not
   * declared is never copied, so no sweep can carry secrets or real user data
   * into a tree nobody reviewed. */
  const composition = args => { try { return resolveStartComposition(args, {}); } catch (error) { return { error }; } };
  check(composition({ drivers: 2, integration_command: 'node tests/run.mjs', integration_runtime_paths: ['data/jobs.json'] }).runtimePaths?.join(',') === 'data/jobs.json',
    'A3 a declared integration_runtime_paths reaches the team parallel record (got ' + JSON.stringify(composition({ drivers: 2, integration_command: 'node tests/run.mjs', integration_runtime_paths: ['data/jobs.json'] })) + ')');
  const undeclared = composition({ drivers: 1, integration_runtime_paths: ['data/jobs.json'] });
  check(/integration_runtime_paths/.test(undeclared.error?.message ?? ''), 'A3 a declaration with no isolated checkout to seed is refused, not silently dropped (got ' + (undeclared.error?.message ?? 'no error') + ')');
  check(composition({ drivers: 1 }).runtimePaths?.length === 0, 'A3 omitting the declaration is the default and seeds nothing');
  await test('isolated HEAD/index and immutable candidate snapshot', async root => {
    const parallel = await create(root), { driver, driver2 } = parallel.slots;
    assert.notEqual(await git(driver.path, 'rev-parse', '--git-path', 'index'), await git(driver2.path, 'rev-parse', '--git-path', 'index'));
    await writeFile(join(driver.path, 'a.txt'), 'staged\n'); await git(driver.path, 'add', 'a.txt');
    await writeFile(join(driver.path, 'a.txt'), 'candidate\n');
    const before = await git(driver.path, 'diff', '--cached');
    const candidate = await snapshotCandidate(driver, ['a.txt']);
    assert.equal(await git(driver.path, 'diff', '--cached'), before);
    assert.equal(await git(driver.path, 'rev-parse', 'HEAD'), parallel.baseHead);
    assert.equal(await git(driver2.path, 'rev-parse', 'HEAD'), parallel.baseHead);
    assert.equal(await readFile(join(driver2.path, 'a.txt'), 'utf8'), 'A\n');
    assert.equal(await git(root, 'show', `${candidate.commit}:a.txt`), 'candidate');
    const warnings = await removeDriverWorktrees(parallel);
    assert.ok(warnings.length); assert.equal(await readFile(join(driver.path, 'a.txt'), 'utf8'), 'candidate\n');
  });
  await test('independent candidates integrate serially and verify the combined tree', async root => {
    const parallel = await create(root), { driver, driver2 } = parallel.slots;
    await writeFile(join(driver.path, 'a.txt'), 'new A\n');
    await writeFile(join(driver2.path, 'b.txt'), 'new B\n');
    const a = await snapshotCandidate(driver, ['a.txt']), b = await snapshotCandidate(driver2, ['b.txt']);
    let visits = 0, active = 0;
    const verify = async cwd => {
      visits++; assert.equal(++active, 1);
      if (visits === 2) { assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'new A\n'); assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'new B\n'); }
      active--;
    };
    const settled = await Promise.allSettled([
      integrateCandidate(parallel, a, { verify }),
      integrateCandidate(parallel, b, { verify }),
    ]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    const results = settled.map(result => result.value);
    const finalHead = await git(root, 'rev-parse', 'HEAD');
    assert.ok(results.some(result => result.head === finalHead)); assert.equal(visits, 2);
    const again = await integrateCandidate(parallel, b, { verify: async cwd => {
      assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'new A\n'); assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'new B\n'); visits++;
    } });
    assert.equal(again.head, finalHead);
    assert.equal(visits, 3);
  });
  await test('merge conflict and failed verification leave primary unchanged', async root => {
    const parallel = await create(root), { driver, driver2 } = parallel.slots;
    await writeFile(join(driver.path, 'a.txt'), 'first\n'); await writeFile(join(driver2.path, 'a.txt'), 'second\n');
    const a = await snapshotCandidate(driver, ['a.txt']), b = await snapshotCandidate(driver2, ['a.txt']);
    await assert.rejects(integrateCandidate(parallel, a, { verify: async () => { throw Error('oracle failed'); } }), /oracle failed/);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), parallel.baseHead);
    await integrateCandidate(parallel, a, { verify: async () => {} });
    const before = await git(root, 'rev-parse', 'HEAD');
    await assert.rejects(integrateCandidate(parallel, b, { verify: async () => assert.fail('conflict must not verify') }));
    assert.equal(await git(root, 'rev-parse', 'HEAD'), before);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'first\n');
  });
  await test('scope escapes and dirty canonical workspace are rejected', async root => {
    const parallel = await create(root);
    await writeFile(join(parallel.slots.driver.path, 'b.txt'), 'escape\n');
    await assert.rejects(snapshotCandidate(parallel.slots.driver, ['a.txt']), /scope/i);
    await assert.rejects(snapshotCandidate(parallel.slots.driver, ['../']), /relative|scope|path/i);
    await writeFile(join(parallel.slots.driver.path, 'b.txt'), 'B\n');
    await writeFile(join(parallel.slots.driver.path, ' a.txt'), 'leading space\n');
    await assert.rejects(snapshotCandidate(parallel.slots.driver, ['a.txt']), /scope/i);
    await writeFile(join(root, 'a.txt'), 'user edit\n');
    await assert.rejects(createDriverWorktrees(root, join(root, '.pair-programming'), 'other'), /clean|dirty/i);
  });
  await test('primary change during verification invalidates promotion', async root => {
    const parallel = await create(root);
    await writeFile(join(parallel.slots.driver.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['a.txt']);
    let externalHead;
    await assert.rejects(integrateCandidate(parallel, candidate, { verify: async () => {
      await writeFile(join(root, 'b.txt'), 'external\n'); await git(root, 'add', 'b.txt'); await git(root, 'commit', '-m', 'external'); externalHead = await git(root, 'rev-parse', 'HEAD');
    } }), /changed|stale/i);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), externalHead);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'A\n');
  });
  await test('oracle scope is explicit and dirty canonical oracles cannot be overwritten', async root => {
    const parallel = await create(root), slot = parallel.slots.driver;
    await mkdir(join(slot.path, '.pair-oracles'));
    await writeFile(join(slot.path, '.pair-oracles', 'own.mjs'), 'export default true;\n');
    await assert.rejects(snapshotCandidate(slot, ['a.txt']), /scope/);
    const candidate = await snapshotCandidate(slot, ['.pair-oracles/own.mjs']);
    assert.deepEqual(candidate.files, ['.pair-oracles/own.mjs']);
    await mkdir(join(root, '.pair-oracles')); await writeFile(join(root, '.pair-oracles', 'own.mjs'), 'user oracle\n');
    await assert.rejects(integrateCandidate(parallel, candidate, { verify: async () => {} }), /clean/);
    assert.equal(await readFile(join(root, '.pair-oracles', 'own.mjs'), 'utf8'), 'user oracle\n');
  });
  await test('autocrlf checkout preserves the sealed LF oracle through integration and promotion', async root => {
    await git(root, 'config', 'core.autocrlf', 'true');
    const parallel = await create(root), slot = parallel.slots.driver;
    assert.equal(await readFile(join(slot.path, 'a.txt'), 'utf8'), 'A\n', 'Driver checkout must not introduce implicit CRLF');
    const file = '.pair-oracles/own.mjs', content = 'import assert from "node:assert/strict";\nassert.equal(1 + 1, 2);\n';
    await mkdir(join(slot.path, '.pair-oracles'));
    await writeFile(join(slot.path, file), content);
    const sealed = await digestOracleFiles(slot.path, [file]);
    const candidate = await snapshotCandidate(slot, [file]);
    const blob = (await exec('git', ['show', `${candidate.commit}:${file}`], { cwd: root, encoding: 'utf8' })).stdout;
    assert.equal(blob, content, 'snapshot must retain the frozen bytes');
    await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(await digestOracleFiles(cwd, [file]), sealed, 'disposable checkout must match the actual frozen digest');
    } });
    assert.equal(await digestOracleFiles(root, [file]), sealed, 'canonical promotion must preserve the same bytes');
    assert.equal(await readFile(join(root, file), 'utf8'), content);
    await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(await digestOracleFiles(cwd, [file]), sealed, 'rechecking an integrated candidate must preserve its existing seal on checkout');
    } });
    assert.equal(await git(root, 'config', '--get', 'core.autocrlf'), 'true', 'user Git configuration must remain untouched');
  });
  await test('explicit checkout attributes cannot silently waive a frozen oracle mismatch', async root => {
    await writeFile(join(root, '.gitattributes'), '.pair-oracles/** text eol=crlf\n');
    await git(root, 'add', '.gitattributes'); await git(root, 'commit', '-m', 'explicit CRLF oracle checkout');
    const parallel = await create(root), slot = parallel.slots.driver;
    const file = '.pair-oracles/own.mjs';
    await mkdir(join(slot.path, '.pair-oracles'));
    await writeFile(join(slot.path, file), 'export default true;\n');
    const sealed = await digestOracleFiles(slot.path, [file]);
    const candidate = await snapshotCandidate(slot, [file]);
    await assert.rejects(integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(await digestOracleFiles(cwd, [file]), sealed, 'frozen oracle mismatch');
    } }), /frozen oracle mismatch/);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), parallel.baseHead);
  });
  await test('cancellation and verifier mutations refuse promotion and remove disposable checkout', async root => {
    const parallel = await create(root), slot = parallel.slots.driver;
    await writeFile(join(slot.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(slot, ['a.txt']);
    const abort = new AbortController();
    await assert.rejects(integrateCandidate(parallel, candidate, { signal: abort.signal, verify: async () => { abort.abort(); } }), /abort/i);
    await assert.rejects(integrateCandidate(parallel, candidate, { verify: async cwd => { await writeFile(join(cwd, 'b.txt'), 'tampered\n'); } }), /clean/);
    assert.equal(await git(root, 'rev-parse', 'HEAD'), parallel.baseHead);
    assert.equal((await git(root, 'worktree', 'list', '--porcelain')).includes('integration-'), false);
    await assert.rejects(integrateCandidate(parallel, { commit: '--abort' }, { verify: async () => {} }), /commit id/);
  });
  await test('only clean owned Driver worktrees are removed', async root => {
    const parallel = await create(root);
    assert.deepEqual(await removeDriverWorktrees(parallel), []);
    assert.equal((await git(root, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
    await assert.rejects(createDriverWorktrees(root, join(root, '..', 'outside-state'), 'escape'), /inside/);
    await assert.rejects(createDriverWorktrees(root, join(root, '.git', 'state'), 'escape'), /metadata/);
  });
  // The integration checkout is a Git worktree, so it materialises TRACKED files
  // only. data/jobs.json is the run's ignored runtime input; data/notes.json is
  // tracked so that a candidate can legitimately carry its own copy of it.
  const runtimeFixture = async root => {
    await writeFile(join(root, '.gitignore'), 'data/jobs.json\n');
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'jobs.json'), '{"pool":"canonical"}\n');
    await writeFile(join(root, 'data', 'notes.json'), '{"notes":"base"}\n');
    await git(root, 'add', '.gitignore', 'data/notes.json');
    await git(root, 'commit', '-m', 'runtime inputs');
  };
  await test('a declared runtime input is seeded into the disposable merged tree', async root => {
    await runtimeFixture(root);
    const parallel = await create(root);
    parallel.runtimePaths = ['data/jobs.json'];
    await writeFile(join(parallel.slots.driver.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['a.txt']);
    const result = await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(await readFile(join(cwd, 'data', 'jobs.json'), 'utf8'), '{"pool":"canonical"}\n');
      // Copied, never linked: this checkout is force-removed afterwards, and that
      // removal DELETES THROUGH a junction (measured on this host: the link's
      // source directory came back empty, exit 0, silent).
      assert.equal(lstatSync(join(cwd, 'data', 'jobs.json')).isSymbolicLink(), false);
    } });
    assert.deepEqual(result.runtimeSeed, { declared: ['data/jobs.json'], seeded: ['data/jobs.json'], skipped: [], missing: [] });
  });
  await test('without a declaration nothing is copied into the merged tree', async root => {
    await runtimeFixture(root);
    const parallel = await create(root);
    await writeFile(join(parallel.slots.driver.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['a.txt']);
    const result = await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(existsSync(join(cwd, 'data', 'jobs.json')), false, 'an undeclared runtime input was invented from the canonical workspace');
    } });
    assert.deepEqual(result.runtimeSeed, { declared: [], seeded: [], skipped: [], missing: [] });
  });
  await test('a candidate carrying its own tracked runtime file wins over the seed', async root => {
    await runtimeFixture(root);
    const parallel = await create(root);
    parallel.runtimePaths = ['data/notes.json'];
    await writeFile(join(parallel.slots.driver.path, 'data', 'notes.json'), '{"notes":"candidate"}\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['data/notes.json']);
    const result = await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(await readFile(join(cwd, 'data', 'notes.json'), 'utf8'), '{"notes":"candidate"}\n');
    } });
    assert.deepEqual(result.runtimeSeed, { declared: ['data/notes.json'], seeded: [], skipped: [{ path: 'data/notes.json', reason: 'already present in the merged tree; the candidate wins' }], missing: [] });
  });
  await test('a declared input missing from the canonical workspace is an environment diagnostic', async root => {
    await runtimeFixture(root);
    const parallel = await create(root);
    parallel.runtimePaths = ['data/jobs.json'];
    await rm(join(root, 'data', 'jobs.json'));
    await writeFile(join(parallel.slots.driver.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['a.txt']);
    const seeded = await integrateCandidate(parallel, candidate, { verify: async () => true });
    assert.deepEqual(seeded.runtimeSeed.missing, ['data/jobs.json']);
    // Whatever an oracle prints in an incomplete tree is a statement about the
    // environment, so the failure must name it rather than read as a bad candidate.
    const failure = await integrateCandidate(parallel, candidate, { verify: async () => {
      throw new Error('PREREQ: the pool could not be read in THIS workspace');
    } }).catch(error => error);
    assert.match(failure.message, /PREREQ: the pool could not be read in THIS workspace/);
    assert.match(failure.message, /INTEGRATION_ENVIRONMENT/);
    assert.deepEqual(failure.runtimeSeed.missing, ['data/jobs.json']);
  });
  await test('a declared path that is a link is never traversed or copied', async root => {
    // A Windows directory junction is the measured case: Git traverses it, stat()
    // reports a directory, and a force-removal deletes through it.
    await writeFile(join(root, '.gitignore'), 'data\nrealdata\n');
    await mkdir(join(root, 'realdata'));
    await writeFile(join(root, 'realdata', 'jobs.json'), '{"pool":"canonical"}\n');
    symlinkSync(join(root, 'realdata'), join(root, 'data'), 'junction');
    await git(root, 'add', '.gitignore'); await git(root, 'commit', '-m', 'runtime junction');
    const parallel = await create(root);
    parallel.runtimePaths = ['data'];
    await writeFile(join(parallel.slots.driver.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['a.txt']);
    const result = await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(existsSync(join(cwd, 'data')), false, 'a link was traversed into the disposable checkout');
    } });
    assert.deepEqual(result.runtimeSeed, { declared: ['data'], seeded: [], skipped: [{ path: 'data', reason: 'not a regular file or a real directory (a link is never followed or copied)' }], missing: [] });
  });
  await test('a declared directory seeds regular files and never descends into a link', async root => {
    await writeFile(join(root, '.gitignore'), 'runtime\nreallink\n');
    await mkdir(join(root, 'runtime'));
    await mkdir(join(root, 'reallink'));
    await writeFile(join(root, 'reallink', 'secret.txt'), 'not a runtime input\n');
    await writeFile(join(root, 'runtime', 'jobs.json'), '{"pool":"canonical"}\n');
    symlinkSync(join(root, 'reallink'), join(root, 'runtime', 'nested'), 'junction');
    await git(root, 'add', '.gitignore'); await git(root, 'commit', '-m', 'runtime directory');
    const parallel = await create(root);
    parallel.runtimePaths = ['runtime'];
    await writeFile(join(parallel.slots.driver.path, 'a.txt'), 'candidate\n');
    const candidate = await snapshotCandidate(parallel.slots.driver, ['a.txt']);
    const result = await integrateCandidate(parallel, candidate, { verify: async cwd => {
      assert.equal(await readFile(join(cwd, 'runtime', 'jobs.json'), 'utf8'), '{"pool":"canonical"}\n');
      assert.equal(existsSync(join(cwd, 'runtime', 'nested')), false, 'the walk descended into a link');
    } });
    assert.deepEqual(result.runtimeSeed, { declared: ['runtime'], seeded: ['runtime/jobs.json'], skipped: [{ path: 'runtime/nested', reason: 'not a regular file or a real directory (a link is never followed or copied)' }], missing: [] });
  });
  await test('scopes detect read/write and directory/resource conflicts conservatively', async () => {
    assert.equal(scopeConflicts({ writes: ['src/'], reads: [] }, { writes: ['test.js'], reads: ['src/api.js'] }), true);
    assert.equal(scopeConflicts({ writes: ['a.txt'] }, { writes: ['b.txt'] }), false);
    assert.equal(scopeConflicts({ writes: ['a.txt'], resources: ['schema'] }, { writes: ['b.txt'], resources: ['schema'] }), true);
    assert.equal(scopeConflicts({}, { writes: ['b.txt'] }), true);
    assert.equal(scopeConflicts({ writes: [] }, { writes: ['b.txt'] }), true);
    assert.equal(scopeConflicts({ writes: ['src/a.js'] }, { writes: ['src/ab.js'] }), false);
  });
}
