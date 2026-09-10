import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkDeliverables} from '../lib/tools/gate-exec.js';
export async function run(check) {
 const root=await mkdtemp(join(tmpdir(),'pair-artifacts-'));
 const outside=await mkdtemp(join(tmpdir(),'pair-outside-'));
 try {
  await mkdir(join(root,'tree/nested'),{recursive:true});
  await writeFile(join(root,'tree/nested/empty'),'');
  assert.equal((await checkDeliverables(root,['tree'])).ok,false);
  await writeFile(join(root,'tree/nested/report'),'content');
  assert.equal((await checkDeliverables(root,['tree/'])).ok,true);
  assert.equal((await checkDeliverables(root,['tree/nested/report'])).ok,true);
  assert.equal((await checkDeliverables(root,['tree/nested/empty'])).ok,false);
  assert.equal((await checkDeliverables(root,['missing'])).ok,false);
  await writeFile(join(outside,'report'),'external');
  await symlink(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir');
  assert.equal((await checkDeliverables(root,['escape/report'])).ok,false);
  await mkdir(join(root,'links'));
  await symlink(outside,join(root,'links/external'),process.platform==='win32'?'junction':'dir');
  assert.equal((await checkDeliverables(root,['links'])).ok,false);
  check(true,'directories need non-empty regular content; empty, missing and escaping targets fail');
 } catch(error){check(false,error.stack);}
 finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
}
