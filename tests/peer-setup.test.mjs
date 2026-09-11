import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
export async function run(check) {
  const root=await mkdtemp(join(tmpdir(),'pair-peer-safety-'));
  const invoke=(cwd,args=[])=>spawnSync(process.execPath,['scripts/setup-peers.mjs',...args],{cwd,encoding:'utf8',timeout:10000});
  try {
    await mkdir(join(root,'scripts'));await cp(new URL('../scripts/setup-peers.mjs',import.meta.url),join(root,'scripts/setup-peers.mjs'));
    const manifest={type:'module',peerDependencies:{'@deepseek-ai/dsh-tools':'*'}};
    await writeFile(join(root,'package.json'),JSON.stringify(manifest));
    const runner=new URL('./run.mjs',import.meta.url).href;
    const probe=spawnSync(process.execPath,['--input-type=module','-e',`try { await import(${JSON.stringify(runner)}); } catch(e) { if (!e.message.includes('PAIR_TEST_PROCESS_REQUIRED')) throw e; console.log('HOST_SURVIVED'); }`],{encoding:'utf8',timeout:10000});
    check(probe.status===0 && probe.stdout.includes('HOST_SURVIVED'),'importing the full runner refuses before suites or process.exit can terminate its host');
    const startup=new URL('../scripts/verify-startup.mjs',import.meta.url).href;
    const startupProbe=spawnSync(process.execPath,['--input-type=module','-e',`try { await import(${JSON.stringify(startup)}); } catch(e) { if (!e.message.includes('PAIR_TEST_PROCESS_REQUIRED')) throw e; console.log('HOST_SURVIVED'); }`],{encoding:'utf8',timeout:10000});
    check(startupProbe.status===0 && startupProbe.stdout.includes('HOST_SURVIVED'),'startup verification also refuses in-host import before loading the plugin');
    const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    check(!pkg.scripts.verify.includes('setup-peers'),'verify never installs or repoints dependencies');
    check(pkg.scripts.postinstall?.includes('--check --optional'),'postinstall is an advisory read-only dependency check');
    const source=await readFile(new URL('../scripts/verify-startup.mjs',import.meta.url),'utf8');
    check(!/rmSync|symlinkSync|mkdirSync/.test(source),'startup verification cannot create or delete dependency entries');
    const absent=invoke(root);
    check(absent.status!==0 && /missing|unresolved/i.test(absent.stderr),'missing dependencies fail with an actionable read-only diagnosis');
    const sdk=join(root,'sdk','@deepseek-ai');await mkdir(join(sdk,'dsh-tools'),{recursive:true});
    await writeFile(join(sdk,'dsh-tools','package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',main:'index.js'}));
    await writeFile(join(sdk,'dsh-tools','index.js'),'module.exports = {};');
    const linked=invoke(root,['--link','--sdk',sdk]);
    check(linked.status===0 && (await lstat(join(root,'node_modules','@deepseek-ai'))).isSymbolicLink(),'explicit setup creates only the requested missing peer link');
    const repeat=invoke(root);check(repeat.status===0,'ordinary verification accepts existing resolvable peers without repointing');
    const sentinel=await readFile(join(sdk,'dsh-tools','index.js'),'utf8');
    const refusal=invoke(root,['--link','--sdk',sdk]);
    check(refusal.status!==0 && /exists|replace/i.test(refusal.stderr),'explicit setup refuses to replace even an existing junction');
    assert.equal(await readFile(join(sdk,'dsh-tools','index.js'),'utf8'),sentinel);
    // Remove the link itself, never recursively clean a fixture containing it.
    await rm(join(root,'node_modules','@deepseek-ai'),{force:true});
    const ordinary=join(root,'node_modules','@deepseek-ai');await mkdir(ordinary);
    await writeFile(join(ordinary,'owned.txt'),'do not delete');
    const preserve=invoke(root,['--link','--sdk',sdk]);
    check(preserve.status!==0 && await readFile(join(ordinary,'owned.txt'),'utf8')==='do not delete','explicit setup preserves a real peer directory and its contents');
    const optional=invoke(root,['--check','--optional']);
    check(optional.status===0 && optional.stderr.includes('Unresolved peers'),'postinstall reports missing peers without failing installation or repairing directories');

  } finally { await rm(root,{recursive:true,force:true}); }
}
