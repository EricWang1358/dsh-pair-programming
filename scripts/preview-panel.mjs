/** Browser QA only: disposable sample board, real DSH RPC/session services, no LLM. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mountPanelFixture } from './panel-fixture.mjs';
const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair 运行台 · 示例预览</title><link rel="icon" href="data:,"><style>
*{box-sizing:border-box}body{margin:0;background:#edf1f4;color:#243442;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}
.demo-top{display:flex;align-items:center;gap:12px;padding:14px 24px;background:#152b2c;color:#dbede9;font-size:12px;flex-wrap:wrap}.demo-top strong{margin-right:auto;letter-spacing:.06em}.demo-top button{background:#284243;color:inherit;border:1px solid #4c6564;padding:7px 12px;border-radius:6px;cursor:pointer}
#frame{width:min(1120px,calc(100% - 48px));height:calc(100vh - 100px);margin:22px auto;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid #d9e1e5;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px #1933300b}
#frame.narrow{width:min(380px,calc(100% - 24px))}#app{height:100%}
body.dark{background:#101619;--dsw-alias-bg-layer-1:#192125;--dsw-alias-bg-layer-2:#222d32;--dsw-alias-label-primary:#e1e9eb;--dsw-alias-label-secondary:#9aadb5;--dsw-alias-border-l2:#334149;--dsw-alias-brand-primary:#53c9b6;--dsw-alias-state-success-primary:#6ec8a3;--dsw-alias-state-warn-primary:#e0ac68;--dsw-alias-label-tertiary:#71848c}
</style><div class="demo-top"><strong>PAIR / 示例预览 · 非真实团队</strong><span>真实 DSH 数据桥 · 零模型调用</span><button id="advance">推进示例任务</button><button id="width">切换窄侧栏</button><button id="theme">切换深浅色</button></div><main id="frame"><div id="app"></div></main>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/panel.js"></script><script>
var token=__TOKEN__,Seat,cleanups=[],translations,requests=0;
var ctx={effect:function(fn){var off=fn();if(typeof off==='function')cleanups.push(off);},locale:{register:function(ns,d){translations=d.zh;return function(){};},bind:function(){return function(k){return translations[k]||k;};}},get:function(name){return {rpc:{call:async function(channel,method,payload,signal){requests++;var response=await fetch(channel+'/'+method,{method:'POST',signal:signal,headers:{'content-type':'application/json','x-panel-fixture':token},body:JSON.stringify({type:'client-request',rpcId:String(requests),method:method,payload:payload})});if(!response.ok)throw new Error('HTTP '+response.status);return (await response.json()).result;}}};},inject:function(names,fn){if(names[0]==='sidebarRightTabs')return;return fn(ctx);},slots:{inject:function(name,fn){return fn();},register:function(desc,component){if(desc.name==='conversation.view')Seat=component;return function(){};}},on:function(){return function(){};}};
installPairRuntimePanel(ctx,React);ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(Seat,{sessionId:'panel-captain'}));
document.getElementById('theme').onclick=function(){document.body.classList.toggle('dark');};
document.getElementById('width').onclick=function(){document.getElementById('frame').classList.toggle('narrow');};
document.getElementById('advance').onclick=async function(){await fetch('/demo/advance',{method:'POST',headers:{'x-panel-fixture':token}});};
</script></html>`;
const fixture = await mountPanelFixture({ serve: async (req, res, state) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/demo/advance' && req.method === 'POST') {
    if (req.headers['x-panel-fixture'] !== state.token) { res.writeHead(401); res.end(); return true; }
    const task = state.board.tasks.find(t => t.status === 'in_progress');
    if (task) { task.status = 'completed'; task.updatedAt = Date.now(); await state.save(); }
    res.writeHead(204);res.end();return true;
  }
  let data, type = 'text/javascript; charset=utf-8';
  if (path === '/') { data = page.replace('__TOKEN__', JSON.stringify(state.token)); type='text/html; charset=utf-8'; }
  else if (path === '/panel.js') {
    const code = await readFile(new URL('../lib/client/panel.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../lib/client/panel.css', import.meta.url), 'utf8');
    data = code.replace("/* PAIR_PANEL_CSS */ ''", JSON.stringify(css));
  } else if (path === '/react.js' || path === '/react-dom.js') {
    const name = path === '/react.js' ? 'react' : 'react-dom';
    const deps = process.env.PAIR_PANEL_PREVIEW_DEPS || join(tmpdir(), 'pair-panel-preview-deps', 'node_modules');
    data = await readFile(join(deps, name, 'umd', name + '.development.js'));
  } else return false;
  res.writeHead(200, { 'content-type': type, 'cache-control':'no-store' });res.end(data);return true;
}});
await writeFile(join(tmpdir(), 'pair-panel-preview.json'), JSON.stringify({ url: fixture.url, workspace: fixture.workspace }));
console.log('PREVIEW ' + fixture.url);
process.on('SIGINT', async () => { await fixture.close(); process.exit(0); });
