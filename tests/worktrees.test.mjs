import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOracleFiles } from '../lib/tools/oracle-exec.js';
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
  await test('scopes detect read/write and directory/resource conflicts conservatively', async () => {
    assert.equal(scopeConflicts({ writes: ['src/'], reads: [] }, { writes: ['test.js'], reads: ['src/api.js'] }), true);
    assert.equal(scopeConflicts({ writes: ['a.txt'] }, { writes: ['b.txt'] }), false);
    assert.equal(scopeConflicts({ writes: ['a.txt'], resources: ['schema'] }, { writes: ['b.txt'], resources: ['schema'] }), true);
    assert.equal(scopeConflicts({}, { writes: ['b.txt'] }), true);
    assert.equal(scopeConflicts({ writes: [] }, { writes: ['b.txt'] }), true);
    assert.equal(scopeConflicts({ writes: ['src/a.js'] }, { writes: ['src/ab.js'] }), false);
  });
}
