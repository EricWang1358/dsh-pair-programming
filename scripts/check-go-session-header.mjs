/** Native adapter transport-boundary probe. No network, credentials or model calls. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { PiAiAdapter } = await import(pathToFileURL(process.argv[2]).href);
const model={id:'test',api:'openai-completions',provider:'test',baseUrl:'https://opencode.ai/zen/go/v1',contextWindow:10000,maxTokens:1000,input:['text'],reasoning:false};
const profile={headers:{'X-OpenCode-Session':'stale-global','X-DeepSeek-Harness-Session-Id':'stale-native','x-custom':'keep'},streamIdleTimeoutMs:5000};
const adapter=new PiAiAdapter({resolveApiKey:async()=>undefined});
adapter.profileOf=()=>profile;adapter.modelOf=()=>model;
async function capture(sessionId) {
  let captured;
  const stop=new Error('LOCAL_CAPTURE');
  const snapshot={models:{streamSimple(_model,_context,options){captured=options;throw stop;}}};
  try { await adapter.streamWithSnapshot({provider:'test',model:'test',messages:[],tools:[],...(sessionId===undefined?{}:{sessionId})},snapshot).next(); }
  catch(error) { if(!captured)throw error; }
  assert.ok(captured,'stream options reached the native transport seam');
  return captured.headers;
}
const first=await capture('session-a');const retry=await capture('session-a');const sibling=await capture('session-b');const absent=await capture();
assert.equal(first['x-opencode-session'],'session-a');
assert.equal(first['x-deepseek-harness-session-id'],'session-a');
assert.equal(retry['x-opencode-session'],first['x-opencode-session']);
assert.equal(sibling['x-opencode-session'],'session-b');
assert.equal(Object.keys(first).filter(k=>k.toLowerCase()==='x-opencode-session').length,1);
assert.equal(first['x-custom'],'keep');
assert.ok(!Object.keys(absent).some(k=>['x-opencode-session','x-deepseek-harness-session-id'].includes(k.toLowerCase())));
console.log('PASS: native stream seam; stable retry, separate sessions, static-header collision removed, absent ID not fabricated. No network calls.');
