/** Dependency inspection is read-only. Linking is explicit and never replaces an entry. */
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(join(root,'package.json'));
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const peers=Object.keys({...pkg.peerDependencies,...pkg.dependencies}).filter(n=>n.startsWith('@deepseek-ai/'));
const args=process.argv.slice(2);
const unresolved=()=>peers.filter(name=>{try{require.resolve(name);return false;}catch{return true;}});
function entryExists(path){try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
try {
  if(args.includes('--link')) {
    const pos=args.indexOf('--sdk');
    if(pos<0||!args[pos+1]||args[pos+1].startsWith('--'))throw new Error('Explicit linking requires --sdk <host node_modules/@deepseek-ai>');
    const sdk=realpathSync(resolve(args[pos+1]));
    const missing=peers.filter(name=>!existsSync(join(sdk,name.slice('@deepseek-ai/'.length),'package.json')));
    if(missing.length)throw new Error('SDK missing peers: '+missing.join(', '));
    const nm=join(root,'node_modules'),target=join(nm,'@deepseek-ai');
    if(entryExists(target))throw new Error('Peer entry exists; refusing to replace or delete it. Use a separate checkout.');
    if(entryExists(nm)&&lstatSync(nm).isSymbolicLink())throw new Error('Refusing to write through linked node_modules');
    mkdirSync(nm,{recursive:true});
    // symlink creation is exclusive: a competing setup gets EEXIST, never deletion.
    symlinkSync(sdk,target,process.platform==='win32'?'junction':'dir');
  }
  const missing=unresolved();
  if(missing.length)throw new Error('Unresolved peers: '+missing.join(', ')+'. No dependencies were removed or replaced. For a linked development checkout, explicitly run npm run setup:peers -- --link --sdk <host node_modules/@deepseek-ai>.');
  console.log('setup:peers OK: existing peer imports resolve (read-only check).');
} catch(error) {
  console.error('setup:peers: '+error.message);
  // Installing this plugin must not mutate or break the host installation.
  process.exitCode=args.includes('--optional')&&!args.includes('--link')?0:1;
}
