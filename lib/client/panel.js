/* Browser source, assembled with settings.js by scripts/build-client.mjs. */
function createPairPanelSource(call, request, env) {
  env=env||{}; var listeners=new Set(),timer,controller,generation=0,failures=0,legacy=false;
  var schedule=env.setTimeout||setTimeout,cancel=env.clearTimeout||clearTimeout;
  var snapshot={status:'loading',data:null,error:null};
  function emit(next){snapshot=Object.assign({},snapshot,next);listeners.forEach(function(fn){fn();});}
  function stop(){generation++;cancel(timer);if(controller)controller.abort();controller=null;}
  async function pull(){
    if(!listeners.size)return;
    var version=generation,active=new AbortController();controller=active;
    var deadline=schedule(function(){active.abort();},26000);
    try{
      var args=Object.assign({},request);if(snapshot.data)args.revision=snapshot.data.revision;
      var endpoint=snapshot.data?'watch':'snapshot',result;
      try {result=await call(legacy?'/pair-runtime':'/api',legacy?endpoint:'pair-runtime/'+endpoint,args,active.signal);}
      catch(transport){
        if(legacy||!/HTTP (404|405)\b/.test(String(transport.message||transport))||active.signal.aborted)throw transport;
        result=await call('/pair-runtime',endpoint,args,active.signal);legacy=true;
      }
      if(version!==generation||!listeners.size)return;
      if(!result||!result.ok)throw new Error(result&&result.error?result.error.code:'transport');
      var data=result.value;
      if(!data||typeof data.revision!=='string'||!['ready','empty','unavailable'].includes(data.state))throw new Error('invalid-response');
      failures=0;emit({status:'live',data:data,error:null});
      timer=schedule(pull,data.state==='ready'?250:3000);
    }catch(error){
      if(version!==generation||!listeners.size)return;
      failures++;emit({status:snapshot.data?'stale':'error',error:String(error.message||error)});
      timer=schedule(pull,Math.min(30000,2000*Math.pow(2,Math.min(failures-1,4))));
    }finally{cancel(deadline);if(controller===active)controller=null;}
  }
  return {
    getSnapshot:function(){return snapshot;},
    subscribe:function(fn){listeners.add(fn);if(listeners.size===1)pull();return function(){listeners.delete(fn);if(!listeners.size)stop();};},
    refresh:function(){stop();legacy=false;if(listeners.size)pull();},
    dispose:function(){stop();listeners.clear();}
  };
}
var PAIR_PANEL_ZH={
 tab:'Pair 运行台',guide:'团队、任务进度、验收与阻塞',title:'运行中的协作',live:'实时同步',loading:'正在连接',paused:'更新已暂停',stale:'连接中断 · 上次状态',error:'暂时无法读取运行盘',retry:'重新连接',
 empty:'这个会话还没有 Pair 团队',emptyHint:'启动 Pair 后，任务、成员和验收进度会自动出现在这里。查看历史运行请打开原会话。',
 unavailable:'运行信息暂不可用',unavailableHint:'会话或运行盘尚未加载。缺失信息不会被当作零进度。',
 overview:'总览',tasks:'任务',activity:'进展记录',display:'显示设置',comfortable:'舒适',compact:'紧凑',pause:'暂停更新',resume:'恢复更新',
 done:'已完成',total:'任务',acceptance:'需求验收',gate:'当前看板凭证',integration:'集成记录',progressHint:'完成卡数 / 全部卡数；验收与集成分别计算',
 current:'当前重点',clear:'当前没有待处理事项',clearHint:'等待下一次状态变化，无需唤醒团队。',action:'下一步',
 team:'协作席位',pm:'产品发现',awaiting:'待分诊',deferred:'已延期',workflow:'工作流',search:'搜索任务或负责人',all:'全部',active:'进行中',blocked:'需关注',completed:'已完成',
 previous:'上一页',next:'下一页',rows:'条任务',noTasks:'没有匹配的任务',noTasksHint:'尝试清除搜索或切换筛选。',unassigned:'待分配',depends:'前置任务',noDeps:'可独立推进',
 oracle:'冻结验收',recorded:'已记录',pending:'待完成',detail:'任务详情',back:'关闭详情',criteria:'验收条件',design:'设计与协作',responsibility:'职责',approach:'实现方向',failure:'失败处理',contract:'协作契约',
 cyclesHistory:'最近周期',repairs:'命令修复',history:'最近进展',noHistory:'还没有带时间戳的进展记录',knownState:'看板记录',warning:'部分数据受读取上限或文件状态影响，未展示的内容不计作零。',
 single:'单工作区',dual:'隔离双 Driver',updated:'上次同步',readOnly:'只读观察 · 不调用模型',mailbox:'待投递消息',mailboxHint:'宿主接收不等于模型已读；租约内投递不计入待投递。',unknown:'未记录',goal:'本轮目标',
 'stage.queued':'待领取','stage.draft':'待分诊','stage.blocked':'等待依赖','stage.rework':'需要修正','stage.spec':'准备验收','stage.coding':'实现中','stage.review':'待 QA 验证','stage.gate':'待质量门','stage.integration':'待集成','stage.completion':'待收尾','stage.done':'已完成','stage.failed':'已失败','stage.cancelled':'已取消',
 'phase.FORMING':'组队','phase.TASK_GATE':'质量检查','phase.PLANNING':'规划','phase.CYCLING':'迭代','phase.RETRO':'复盘','phase.DONE':'已结束','phase.ABORTED':'已中止',
 'event.created':'建立任务','event.cycle':'开始周期','event.accept':'验收通过','event.reject':'验收拒绝','event.checkpoint':'检查点通过','event.integrated':'集成完成','event.completed':'任务完成','event.repair':'修复检查命令'
};
var PAIR_PANEL_EN={
 tab:'Pair runtime',guide:'Team, task progress, acceptance and blockers',title:'Collaboration in motion',live:'Live',loading:'Connecting',paused:'Updates paused',stale:'Disconnected · last known state',error:'Cannot read the runtime board',retry:'Reconnect',
 empty:'No Pair team in this session',emptyHint:'Start Pair to see its team, tasks and acceptance here. Open the original session for historical runs.',
 unavailable:'Runtime information unavailable',unavailableHint:'The session or board is not loaded. Missing information is not zero progress.',
 overview:'Overview',tasks:'Tasks',activity:'Activity',display:'Display',comfortable:'Comfortable',compact:'Compact',pause:'Pause updates',resume:'Resume updates',
 done:'Completed',total:'tasks',acceptance:'Acceptance coverage',gate:'Current board credentials',integration:'Integration records',progressHint:'Completed cards / all cards; acceptance and integration are separate',
 current:'Needs attention',clear:'Nothing needs attention right now',clearHint:'Waiting for a board change; no team wake needed.',action:'Next action',
 team:'Team seats',pm:'Product discovery',awaiting:'Awaiting triage',deferred:'Deferred',workflow:'Workflow',search:'Search task or owner',all:'All',active:'In progress',blocked:'Needs attention',completed:'Completed',
 previous:'Previous',next:'Next',rows:'tasks',noTasks:'No matching tasks',noTasksHint:'Clear the search or change the filter.',unassigned:'Unassigned',depends:'Dependencies',noDeps:'Independent work',
 oracle:'Frozen oracle',recorded:'Recorded',pending:'Pending',detail:'Task details',back:'Close details',criteria:'Acceptance criteria',design:'Design & collaboration',responsibility:'Responsibility',approach:'Approach',failure:'Failure handling',contract:'Contract',
 cyclesHistory:'Recent cycles',repairs:'Command repairs',history:'Recent activity',noHistory:'No timestamped activity yet',knownState:'Board record',warning:'Some data is limited or unreadable. Omitted information does not mean zero.',
 single:'Single workspace',dual:'Isolated dual Drivers',updated:'Last synced',readOnly:'Read-only · no model calls',mailbox:'Queued messages',mailboxHint:'Host acceptance is not model reading; leased deliveries are excluded.',unknown:'Not recorded',goal:'Iteration goal',
 'stage.queued':'Queued','stage.draft':'Awaiting triage','stage.blocked':'Waiting on dependencies','stage.rework':'Needs correction','stage.spec':'Preparing acceptance','stage.coding':'Implementing','stage.review':'Awaiting QA','stage.gate':'Awaiting gate','stage.integration':'Awaiting integration','stage.completion':'Ready to close','stage.done':'Completed','stage.failed':'Failed','stage.cancelled':'Cancelled',
 'phase.FORMING':'Forming','phase.TASK_GATE':'Quality check','phase.PLANNING':'Planning','phase.CYCLING':'Iterating','phase.RETRO':'Retrospective','phase.DONE':'Finished','phase.ABORTED':'Aborted',
 'event.created':'Task created','event.cycle':'Cycle started','event.accept':'Accepted','event.reject':'Rejected','event.checkpoint':'Checkpoint passed','event.integrated':'Integrated','event.completed':'Task completed','event.repair':'Verification command repaired'
};
Object.assign(PAIR_PANEL_ZH,{'risks':'已知风险','noRisks':'暂无开放风险','gateHint':'只核对看板凭证绑定，不在面板中复跑验收。','evidence':'查看依据','member.working':'工作中','member.idle':'待命','member.ready':'就绪','member.parked':'已暂停','member.removed':'已退役',
 'action.pair_task_claim':'领取下一张可执行任务','action.pair_oracle':'准备并冻结独立验收','action.pair_propose':'提出下一步实现方案','action.pair_green':'提交实现与自测结果','action.pair_verify':'独立验证当前改动','action.pair_gate_check':'执行任务质量检查','action.pair_integrate':'验证候选并集成到主线','action.pair_task_update':'确认任务完成并收尾','action.pair_backlog':'分诊新需求并按价值排序','action.pair_arbitrate':'为当前分歧作出明确裁决','action.risk':'处理阻塞交付的风险'});
Object.assign(PAIR_PANEL_EN,{'risks':'Known risks','noRisks':'No open risks','gateHint':'Board binding only; this panel does not rerun verification.','evidence':'View evidence','member.working':'Working','member.idle':'Idle','member.ready':'Ready','member.parked':'Parked','member.removed':'Retired',
 'action.pair_task_claim':'Claim the next ready task','action.pair_oracle':'Prepare and freeze independent acceptance','action.pair_propose':'Propose the next implementation step','action.pair_green':'Submit implementation and test evidence','action.pair_verify':'Independently verify the current changes','action.pair_gate_check':'Run the task quality gate','action.pair_integrate':'Validate and integrate the candidate','action.pair_task_update':'Confirm task completion','action.pair_backlog':'Triage discoveries by user value','action.pair_arbitrate':'Resolve the current disagreement','action.risk':'Resolve a delivery-blocking risk'});
Object.assign(PAIR_PANEL_ZH,{
 'action.pair_report':'完成批准的实现并提交自测证据','action.pair_review':'审阅当前方案并明确是否可以动手','action.pair_red':'记录可复现的失败用例','action.pair_refactor':'在测试保持通过的前提下整理实现','action.pair_oracle_write':'准备下一项任务的独立验收',
 'attention.blocking-risk':'处理阻塞交付的风险','attention.stale-credential':'质量凭证缺失或已过期，需要重新检查','attention.truncated-seat':'处理被中断的席位与续跑预算','attention.disclosure':'裁决已申报的不确定性','attention.unsunk-residual':'为尚未归档的残余风险安排去向'});
Object.assign(PAIR_PANEL_EN,{
 'action.pair_report':'Complete the approved implementation and report evidence','action.pair_review':'Review the current proposal before implementation','action.pair_red':'Record a reproducible failing case','action.pair_refactor':'Refine the implementation while tests stay green','action.pair_oracle_write':'Prepare independent acceptance for the next task',
 'attention.blocking-risk':'Resolve a delivery-blocking risk','attention.stale-credential':'The quality credential is missing or stale; check again','attention.truncated-seat':'Resolve a truncated seat and its continuation budget','attention.disclosure':'Rule on declared uncertainty','attention.unsunk-residual':'Assign a destination for unfiled residual risks'});
Object.assign(PAIR_PANEL_EN,{seatHistory:'Session replacements',seatHistoryHint:'Recorded replacements; latest 12 per seat. Older runs may have no records. Cache savings are not measured.', 'replacement.recovery':'Failure recovery','replacement.accepted-cycle':'Cycle policy','replacement.unknown':'Unknown reason'});
Object.assign(PAIR_PANEL_ZH,{seatHistory:'\u4f1a\u8bdd\u66ff\u6362\u8bb0\u5f55',seatHistoryHint:'\u4ec5\u7edf\u8ba1\u5df2\u8bb0\u5f55\u7684\u66ff\u6362\uff0c\u6bcf\u5e2d\u4f4d\u663e\u793a\u6700\u8fd1 12 \u6b21\u3002\u65e7\u8fd0\u884c\u53ef\u80fd\u65e0\u8bb0\u5f55\uff1b\u7f13\u5b58\u8282\u7701\u5c1a\u672a\u6d4b\u91cf\u3002','replacement.recovery':'\u6545\u969c\u6062\u590d','replacement.accepted-cycle':'\u5468\u671f\u7b56\u7565','replacement.unknown':'\u539f\u56e0\u672a\u8bb0\u5f55'});
Object.assign(PAIR_PANEL_ZH,{"milestoneProgress":"\u9636\u6bb5\u63a8\u8fdb","milestoneHint":"\u516d\u4e2a\u9636\u6bb5\u7b49\u6743\u8ba1\u6570\uff0c\u4e0d\u4ee3\u8868\u5de5\u4f5c\u91cf\u5b8c\u6210\u7387\uff1b\u65b0\u589e\u4efb\u52a1\u6216\u8fd4\u5de5\u53ef\u80fd\u4f7f\u6bd4\u4f8b\u4e0b\u964d\u3002\u5b8c\u6210\u51ed\u8bc1\u4ecd\u5355\u72ec\u7edf\u8ba1\u3002","milestones":"\u6b63\u5728\u4ea4\u4ed8\u7684\u8fdb\u5c55","acceptedIncrements":"\u4e2a\u5df2\u9a8c\u6536\u589e\u91cf","eta":"\u5269\u4f59\u65f6\u95f4\u53c2\u8003","minutes":"\u5206\u949f","etaRough":"\u6309\u5386\u53f2\u56e2\u961f\u541e\u5410\u7c97\u4f30\uff0c\u975e\u627f\u8bfa\uff1b\u4efb\u52a1\u590d\u6742\u5ea6\u4e0e\u7b49\u5f85\u4f1a\u6539\u53d8\u7ed3\u679c","eta.samples":"\u81f3\u5c11\u5b8c\u6210 3 \u5f20\u6709\u65f6\u95f4\u8bb0\u5f55\u7684\u5361\u540e\u4f30\u7b97","eta.blocked":"\u5b58\u5728\u963b\u585e\u6216\u5df2\u505c\u6b62\u63a8\u8fdb\uff0c\u6682\u4e0d\u4f30\u7b97","eta.complete":"\u4efb\u52a1\u5df2\u5168\u90e8\u5b8c\u6210","milestone.0":"\u9a8c\u6536\u5df2\u51bb\u7ed3","milestone.1":"\u5b9e\u73b0\u5df2\u542f\u52a8","milestone.2":"\u5b9e\u73b0\u5df2\u63d0\u4ea4","milestone.3":"\u6700\u7ec8\u5ba1\u67e5\u5df2\u901a\u8fc7","milestone.4":"\u8d28\u91cf\u95e8\u5df2\u901a\u8fc7","milestone.5":"\u4efb\u52a1\u5df2\u5b8c\u6210","event.oracle":"\u51bb\u7ed3\u9a8c\u6536","event.review":"\u65b9\u6848\u5ba1\u9605","event.red":"\u8bb0\u5f55\u5931\u8d25\u7528\u4f8b","event.green":"\u63d0\u4ea4\u901a\u8fc7\u8bc1\u636e","event.report":"\u63d0\u4ea4\u5b9e\u73b0\u62a5\u544a"});
Object.assign(PAIR_PANEL_EN,{"milestoneProgress":"Stage progress","milestoneHint":"Six equally weighted stages, not estimated work completion. Scope growth or rework may lower this percentage. Completion credentials are counted separately.","milestones":"Delivery progress","acceptedIncrements":"accepted increments","eta":"Remaining time guide","minutes":"minutes","etaRough":"Rough historical team throughput, not a promise; complexity and waiting change the result.","eta.samples":"Needs at least 3 completed cards with timestamps","eta.blocked":"Blocked or no longer advancing; estimate unavailable","eta.complete":"All tasks completed","milestone.0":"Oracle frozen","milestone.1":"Implementation started","milestone.2":"Implementation submitted","milestone.3":"Final review accepted","milestone.4":"Gate passed","milestone.5":"Task completed","event.oracle":"Oracle frozen","event.review":"Proposal reviewed","event.red":"Failing case recorded","event.green":"Passing evidence submitted","event.report":"Implementation reported"});
Object.assign(PAIR_PANEL_ZH,{"errorHint.route":"\u9762\u677f\u670d\u52a1\u63a5\u53e3\u5c1a\u672a\u5c31\u7eea\uff08HTTP 404/405\uff09\u3002\u5347\u7ea7\u540e\u8bf7\u5728\u5f53\u524d\u4efb\u52a1\u7ed3\u675f\u540e\u91cd\u542f DSH\uff0c\u518d\u5237\u65b0\u9875\u9762\uff1b\u65e0\u9700\u91cd\u65b0\u521b\u5efa\u56e2\u961f\u3002","errorHint.auth":"\u9762\u677f\u8bf7\u6c42\u672a\u901a\u8fc7\u5bbf\u4e3b\u8ba4\u8bc1\u3002\u8bf7\u91cd\u65b0\u6253\u5f00\u5df2\u767b\u5f55\u7684 DSH \u9875\u9762\u3002","errorHint.read":"\u5df2\u8fde\u63a5\u5bbf\u4e3b\uff0c\u4f46\u8fd0\u884c\u76d8\u8bfb\u53d6\u5931\u8d25\u3002\u8bf7\u4fdd\u7559\u5f53\u524d\u56e2\u961f\uff0c\u68c0\u67e5\u8fd0\u884c\u6570\u636e\u6216\u65e5\u5fd7\u3002","errorHint.connection":"\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5\u9762\u677f\u670d\u52a1\uff0c\u6b63\u5728\u81ea\u52a8\u91cd\u8bd5\u3002\u5c1a\u4e0d\u80fd\u5224\u65ad\u5f53\u524d\u4efb\u52a1\u8fdb\u5ea6\u3002"});
Object.assign(PAIR_PANEL_EN,{'errorHint.route':'Panel endpoint unavailable (HTTP 404/405). After current work finishes, restart DSH and refresh this page. Keep the existing team.','errorHint.auth':'The host rejected authentication. Reopen an authenticated DSH page.','errorHint.read':'Connected to the host, but the board could not be read. Keep the team and inspect its data or logs.','errorHint.connection':'The panel connection failed and will retry automatically. Task progress is not yet known.'});
function pairPanelErrorHint(error){
 var text=String(error||'');
 return /HTTP (404|405)\b/.test(text)?'errorHint.route':/HTTP (401|403)\b/.test(text)?'errorHint.auth':text==='pair-panel/read'?'errorHint.read':'errorHint.connection';
}
function createPairDashboard(React){
 var h=React.createElement;
 function Chip(p){return h('span',{className:'pair-pill pair-tone-'+(p.tone||'neutral')},p.children);}
 function tone(stage){return stage==='done'?'good':['blocked','rework','failed'].includes(stage)?'warn':['queued','draft','cancelled'].includes(stage)?'neutral':'active';}
 function Stamp(p){return h('time',{dateTime:new Date(p.at).toISOString(),title:new Date(p.at).toLocaleString()},new Date(p.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));}
 function Bar(p){return h('div',{className:'pair-meter',role:'progressbar','aria-label':p.label,'aria-valuemin':0,'aria-valuemax':p.total||1,'aria-valuenow':p.value},h('i',{style:{width:(p.total?Math.min(100,p.value/p.total*100):0)+'%'}}));}
 function explain(t,a){var kind='attention.'+a.kind,key='action.'+a.tool;return t(kind)!==kind?t(kind):t(key)!==key?t(key):t('action');}
 function Detail(p){
  var a=p.task,t=p.t,root=React.useRef(null);
  React.useEffect(function(){var el=root.current,host=el&&el.closest('.pair-panel-host');if(host&&host.clientWidth<700)el.scrollIntoView({block:'start',behavior:'auto'});},[a.id]);
  return h('section',{ref:root,className:'pair-detail','aria-label':t('detail')},
   h('div',{className:'pair-section-head'},h('span',{className:'pair-eyebrow'},a.id),h('button',{className:'pair-text-button',onClick:p.close},t('back'))),
   h('h2',null,a.subject),h(Chip,{tone:tone(a.stage)},t('stage.'+a.stage)),a.description&&h('p',{className:'pair-detail-copy'},a.description),
   h('div',{className:'pair-checks'},[[t('oracle'),a.oracle],[t('gate'),a.gate.current],...(p.parallel?[[t('integration'),a.integrated]]:[]),[t('done'),a.status==='completed']].map(function(x){return h('div',{key:x[0],className:x[1]?'is-done':''},h('i',null),h('span',null,x[0]),h('b',null,t(x[1]?'recorded':'pending')));})),
   h('h3',null,t('depends')),h('p',null,a.dependencies.join(', ')||t('noDeps')),
   h('h3',null,t('criteria')),a.criteria.length?h('ol',{className:'pair-criteria'},a.criteria.map(function(c,i){return h('li',{key:i},c);})):h('p',{className:'pair-muted'},t('unknown')),
   a.design.length>0&&h('div',null,h('h3',null,t('design')),a.design.map(function(d){return h('details',{key:d.useCase,className:'pair-contract'},h('summary',null,d.useCase),
    [[t('responsibility'),d.responsibility],[t('approach'),d.approach],[t('failure'),d.failure]].map(function(v){return v[1]&&h('p',{key:v[0]},h('strong',null,v[0]+' · '),v[1]);}),
    d.interactions.map(function(i,n){return h('p',{key:n},h('strong',null,t('contract')+' → '+i.target+' · '),i.contract);}));})),
   h('h3',null,t('cyclesHistory')),h('div',{className:'pair-cycle-list'},a.cycles.map(function(c){return h('div',{key:c.id},h('code',null,c.id),h(Chip,{tone:c.verdict==='reject'?'warn':c.verdict==='accept'?'good':'neutral'},c.verdict||c.step),c.repairs>0&&h('small',null,t('repairs')+' '+c.repairs));})));
 }

 return function Dashboard(p){
  var t=p.t,payload=p.data,team=payload&&payload.team,c=team&&team.counts,status=p.paused?'paused':p.status;
  var progress=team&&team.progress,percent=progress?progress.percent:c&&c.total?Math.round(c.completed/c.total*100):0;
  function btn(key,handler,on,disabled){return h('button',{key:key,type:'button',disabled:!!disabled,className:'pair-tab'+(on?' is-selected':''),'aria-pressed':!!on,onClick:handler},t(key));}
  var toolbar=h('header',{className:'pair-toolbar'},
   h('div',null,h('div',{className:'pair-eyebrow'},'PAIR / RUNTIME'),h('h1',null,t('title'))),
   h('div',{className:'pair-toolbar-actions'},h('span',{className:'pair-live '+(status==='live'?'is-live':''),role:'status'},h('i',null),t(status)),
    h('details',{className:'pair-display'},h('summary',null,t('display')),h('div',null,
     btn('comfortable',function(){p.setDensity('comfortable');},p.density==='comfortable'),
     btn('compact',function(){p.setDensity('compact');},p.density==='compact'),btn(p.paused?'resume':'pause',p.togglePause,false)))));
  if(!team)return h('div',{className:'pair-runtime pair-density-'+p.density},toolbar,h('div',{className:'pair-empty'},
   h('span',{className:'pair-empty-mark'},'P'),h('h2',null,status==='loading'?t('loading'):status==='error'?t('error'):t(payload&&payload.state==='unavailable'?'unavailable':'empty')),
   h('p',null,t(status==='error'?pairPanelErrorHint(p.error):payload&&payload.state==='unavailable'?'unavailableHint':'emptyHint')),status!=='loading'&&h('button',{className:'pair-button',onClick:p.refresh},t('retry'))));
  var taskList=h('section',{className:'pair-section pair-task-section'},
   h('div',{className:'pair-section-head'},h('h2',null,t('workflow')),h('span',{className:'pair-muted'},team.tasks.total+' '+t('rows'))),
   h('div',{className:'pair-task-controls'},
    h('input',{type:'search',disabled:p.paused,placeholder:t('search'),'aria-label':t('search'),value:p.query,onChange:function(e){p.search(e.target.value);}}),
    h('div',{className:'pair-segment'},['all','active','blocked','completed'].map(function(key){var value=key==='completed'?'done':key;return btn(key,function(){p.filterBy(value);},p.filter===value,p.paused);}))),
   team.tasks.rows.length?h('div',{className:'pair-task-list'},team.tasks.rows.map(function(a){return h('button',{type:'button',disabled:p.paused,key:a.id,className:'pair-task-row'+(p.selected===a.id?' is-selected':''),onClick:function(){p.select(a.id);},'aria-label':a.id+' '+a.subject},
    h('span',{className:'pair-task-index'},a.id),h('span',{className:'pair-task-main'},h('strong',null,a.subject),h('small',null,(a.owner||t('unassigned'))+' · P'+a.priority+(a.waits.length?' · '+t('depends')+' '+a.waits.join(', '):''))),
    h(Chip,{tone:tone(a.stage)},t('stage.'+a.stage)));})):h('div',{className:'pair-inline-empty'},h('strong',null,t('noTasks')),h('p',null,t('noTasksHint'))),
   h('div',{className:'pair-pagination'},h('span',null,team.tasks.total?Math.min(team.tasks.offset+1,team.tasks.total)+'–'+Math.min(team.tasks.offset+team.tasks.rows.length,team.tasks.total)+' / '+team.tasks.total:'0 / 0'),
    h('button',{disabled:p.paused||team.tasks.offset===0,onClick:function(){p.page(Math.max(0,team.tasks.offset-24));}},t('previous')),
    h('button',{disabled:p.paused||team.tasks.offset+24>=team.tasks.total,onClick:function(){p.page(team.tasks.offset+24);}},t('next'))));
  var history=h('section',{className:'pair-section'},h('div',{className:'pair-section-head'},h('h2',null,t('history')),h('span',{className:'pair-muted'},t('knownState'))),
   team.history.length?h('ol',{className:'pair-timeline'},team.history.map(function(e,i){return h('li',{key:e.kind+e.ref+e.at+i,className:'pair-event-'+e.kind},h(Stamp,{at:e.at}),h('i',null),h('div',null,h('strong',null,t('event.'+e.kind)),h('span',null,e.ref+' · '+e.text)));})):h('p',{className:'pair-muted'},t('noHistory')));
  return h('div',{className:'pair-runtime pair-density-'+p.density},toolbar,
   (p.status==='stale'||p.status==='error')&&h('div',{className:'pair-alert',role:'alert'},t('stale'),h('button',{onClick:p.refresh},t('retry'))),
   payload.warnings.length>0&&h('div',{className:'pair-alert'},t('warning')),
   h('div',{className:'pair-run-heading'},h('div',null,h(Chip,{tone:team.phase==='DONE'?'good':team.phase==='ABORTED'?'warn':'active'},t('phase.'+team.phase)),h('span',{className:'pair-muted'},team.parallel?t('dual'):t('single'))),
    payload.teams.length>1?h('select',{'aria-label':t('knownState'),disabled:p.paused,value:team.id,onChange:function(e){p.chooseTeam(e.target.value);}},payload.teams.map(function(x){return h('option',{key:x.id,value:x.id},x.name);})):h('span',{className:'pair-run-name'},team.name)),
   h('section',{className:'pair-hero'},h('div',{className:'pair-progress-disc',style:{'--pair-progress':percent+'%'}},h('div',null,h('strong',null,percent,h('small',null,'%')),h('span',null,t('milestoneProgress')))),
    h('div',{className:'pair-hero-copy'},h('div',{className:'pair-eyebrow'},t('goal')),h('h2',null,team.goal),h('p',null,h('strong',null,c.completed+' / '+c.total),' '+t('total')),h('small',null,t('milestoneHint')))),
   progress&&h('section',{className:'pair-section pair-progress-detail'},
    h('div',{className:'pair-section-head'},h('h2',null,t('milestones')),h('span',{className:'pair-muted'},progress.acceptedIncrements+' '+t('acceptedIncrements'))),
    h('div',{className:'pair-checks'},progress.milestones.map(function(value,i){return h('div',{key:i},h('span',null,t('milestone.'+i)),h('b',null,value+' / '+c.total),h(Bar,{label:t('milestone.'+i),value:value,total:c.total}));})),
    h('p',{className:'pair-muted'},t('eta')+' · '+(progress.eta.reason==='rough'?progress.eta.minMinutes+'–'+progress.eta.maxMinutes+' '+t('minutes')+' · '+t('etaRough'):t('eta.'+progress.eta.reason)))),
   h('div',{className:'pair-metrics'},[[t('acceptance'),c.covered,c.criteria],[t('gate'),c.gateCurrent,c.total],[t('integration'),team.parallel?c.integrated:null,c.total]].map(function(m){return h('div',{key:m[0]},h('span',{title:m[0]===t('gate')?t('gateHint'):undefined},m[0]),h('strong',null,m[1]===null?'—':m[1],h('small',null,m[1]===null?'':' / '+m[2])),m[1]!==null&&h(Bar,{label:m[0],value:m[1],total:m[2]}));})),
   h('nav',{className:'pair-view-tabs','aria-label':t('tab')},['overview','tasks','activity'].map(function(key){return btn(key,function(){p.setView(key);},p.view===key);})),
   p.view==='overview'&&h('div',{className:'pair-overview'},
    h('section',{className:'pair-section pair-attention'},h('div',{className:'pair-section-head'},h('h2',null,t('current')),h(Chip,{tone:team.attention.total?'warn':'good'},team.attention.total)),
     team.attention.items.length?team.attention.items.map(function(a,i){return h('div',{key:i,className:'pair-obligation'},h('div',null,h('strong',null,a.who),h('code',null,a.ref)),h('p',null,explain(t,a)),h('details',{className:'pair-evidence'},h('summary',null,t('evidence')),h('p',null,a.why),a.tool&&h('code',null,a.tool)));}):h('div',{className:'pair-inline-empty'},h('strong',null,t('clear')),h('p',null,t('clearHint')))),
    h('section',{className:'pair-section'},h('div',{className:'pair-section-head'},h('h2',null,t('team')),h('span',{className:'pair-muted'},team.members.length)),
     h('div',{className:'pair-member-list'},team.members.map(function(m){return h('div',{key:m.name,className:'pair-member'},h('span',{className:'pair-avatar'},m.role.slice(0,1).toUpperCase()),h('div',null,h('strong',null,m.name),h('small',null,m.taskIds.join(', ')||m.role)),h(Chip,{tone:m.status==='working'?'active':m.parked?'warn':'neutral'},t('member.'+(m.parked?'parked':m.status))));})),
     h('details',{className:'pair-contract pair-seat-history'},h('summary',null,t('seatHistory')),
      h('p',{className:'pair-muted'},t('seatHistoryHint')),
      team.members.map(function(m){return h('div',{key:m.name},h('strong',null,m.name+' \u00b7 '+(m.replacements==null?t('unknown'):m.replacements)),
       h('ol',{className:'pair-timeline'},(m.seatHistory||[]).map(function(e,i){return h('li',{key:i},h(Stamp,{at:e.at}),h('i',null),h('span',null,t('replacement.'+e.reason)));})));})),
     h('div',{className:'pair-pm-summary'},h('strong',null,t('pm')),h('span',null,team.product.untriaged+' '+t('awaiting')+' / '+team.product.deferred+' '+t('deferred'))),
     team.product.items.map(function(d){return h('details',{className:'pair-contract',key:d.id},h('summary',null,d.observation),h('p',null,d.value));}),
     team.mailboxes&&h('div',{className:'pair-mailboxes'},h('h3',null,t('mailbox')),h('div',null,team.mailboxes.map(function(m){return h('span',{key:m.name},m.name+' ',h('b',null,m.pending===null?'—':m.pending));})),h('small',null,t('mailboxHint'))))),
   p.view==='overview'&&h('details',{className:'pair-risk-summary'},h('summary',null,t('risks')+' · '+team.riskTotal),
    team.risks.length?team.risks.map(function(r){return h('div',{key:r.id},h(Chip,{tone:r.severity==='P2'?'neutral':'warn'},r.severity),h('span',null,r.id+' · '+r.text));}):h('p',null,t('noRisks'))),
   p.view!=='activity'&&h('div',{className:'pair-work-area'+(team.selected?' has-detail':'')},taskList,team.selected&&h(Detail,{task:team.selected,parallel:team.parallel,t:t,close:function(){p.select(null);}})),
   p.view==='activity'&&history,
   h('footer',{className:'pair-footer'},h('span',null,t('readOnly')),h('span',null,t('updated')+' ',h(Stamp,{at:payload.observedAt}))));
 };
}
function installPairRuntimePanel(ctx,React){
 if(typeof ctx.inject!=='function')return;
 var h=React.createElement,css=/* PAIR_PANEL_CSS */ '',ns='pair-runtime',Dashboard=createPairDashboard(React);
 ctx.effect(function(){return ctx.locale.register(ns,{zh:PAIR_PANEL_ZH,en:PAIR_PANEL_EN});},'pair panel copy');
 if(typeof document!=='undefined')ctx.effect(function(){var tag=document.createElement('style');tag.dataset.pairRuntime='';tag.textContent=css;document.head.appendChild(tag);return function(){tag.remove();};},'pair panel styles');
 var translate=ctx.locale.bind(ns);
 function View(props){
  var t=props.t||translate;
  var ts=React.useState(''),teamId=ts[0],setTeam=ts[1],vs=React.useState('overview'),view=vs[0],setView=vs[1];
  var ds=React.useState(function(){try{return localStorage.getItem('pair-runtime-density')==='compact'?'compact':'comfortable';}catch{return 'comfortable';}}),density=ds[0],setDensity=ds[1],ps=React.useState(false),paused=ps[0],setPaused=ps[1];
  var vis=React.useState(typeof document==='undefined'||!document.hidden),visible=vis[0],setVisible=vis[1];
  var ss=React.useState(null),selected=ss[0],setSelected=ss[1],qs=React.useState(''),query=qs[0],setQuery=qs[1],deferredQuery=React.useDeferredValue(query);
  var fs=React.useState('all'),filter=fs[0],setFilter=fs[1],pg=React.useState(0),offset=pg[0],setOffset=pg[1],root=React.useRef(null);
  var request=React.useMemo(function(){var r={sessionId:props.sessionId,filter:filter,offset:offset,query:deferredQuery};if(teamId)r.teamId=teamId;if(selected)r.taskId=selected;return r;},[props.sessionId,teamId,filter,offset,deferredQuery,selected]);
  var source=React.useMemo(function(){return createPairPanelSource(function(channel,endpoint,args,signal){var c=ctx.get('connection');if(!c||!c.rpc)return Promise.reject(new Error('connection-unavailable'));return c.rpc.call(channel,endpoint,args,signal);},request);},[request]);
  React.useEffect(function(){try{localStorage.setItem('pair-runtime-density',density);}catch{}},[density]);
  var active=!!props.sessionId&&!paused&&visible;
  var subscribe=React.useCallback(function(fn){return active?source.subscribe(fn):function(){};},[source,active]);
  var snapshot=React.useSyncExternalStore(subscribe,source.getSnapshot,source.getSnapshot);
  var lastData=React.useRef(null);if(snapshot.data)lastData.current=snapshot.data;
  var displayData=snapshot.data||lastData.current;
  if(displayData&&displayData.team&&displayData.team.selected&&displayData.team.selected.id!==selected)displayData=Object.assign({},displayData,{team:Object.assign({},displayData.team,{selected:null})});
  React.useEffect(function(){return function(){source.dispose();};},[source]);
  React.useEffect(function(){
   if(typeof document==='undefined')return;
   var inView=true;function update(){setVisible(inView&&!document.hidden);}
   document.addEventListener('visibilitychange',update);
   var observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(function(entries){inView=entries.some(function(e){return e.isIntersecting;});update();});
   if(observer&&root.current)observer.observe(root.current);
   return function(){document.removeEventListener('visibilitychange',update);if(observer)observer.disconnect();};
  },[]);
  React.useEffect(function(){if(typeof ctx.on!=='function')return;return ctx.on('connection/reset',function(){source.refresh();});},[source]);
  return h('div',{ref:root,className:'pair-panel-host'},h(Dashboard,{
   data:displayData,error:snapshot.error,status:props.sessionId?snapshot.status:'paused',t:t,view:view,setView:setView,density:density,setDensity:setDensity,paused:paused||!visible,
   togglePause:function(){setPaused(function(x){return !x;});},refresh:source.refresh,query:query,filter:filter,selected:selected,
   search:function(v){setQuery(v.slice(0,160));setOffset(0);},filterBy:function(v){setFilter(v);setOffset(0);},page:setOffset,select:setSelected,
   chooseTeam:function(id){lastData.current=null;setTeam(id);setSelected(null);setOffset(0);setQuery('');}
  }));
 }
 function Seat(props){return h(View,Object.assign({},props,{key:props.sessionId||'empty'}));}
 ctx.slots.inject('conversation.view',function(){return ctx.slots.register({name:'conversation.view',id:'pair-runtime',order:25,locale:ns,label:function(){return translate('tab');}},Seat);});
 ctx.inject(['sidebarRightTabs'],function(c){
  var tabs=c.sidebarRightTabs;if(!tabs||typeof tabs.register!=='function')return;var disposeType,disposeBody;
  try{
   disposeType=tabs.register({id:'pair-runtime',kind:'pair-runtime',title:function(){return translate('tab');},guide:[{order:25,title:function(){return translate('tab');},description:function(){return translate('guide');}}]});
   disposeBody=c.slots.inject('sidebar.right.pane.tab',function(){return c.slots.register({name:'sidebar.right.pane.tab',key:'pair-runtime',locale:ns},Seat);});
  }catch(error){if(disposeType)disposeType();return;}
  return function(){if(disposeBody)disposeBody();if(disposeType)disposeType();};
 });
}
