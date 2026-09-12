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
// Plain-language copy: readers want to know how far the goal is, what the team is doing and whether anything is stuck.
var PAIR_PANEL_ZH={
 tab:'Pair 运行台',guide:'团队在做什么、做到哪了、有没有卡住',title:'目标进度',live:'实时更新',loading:'正在连接',paused:'已暂停刷新',stale:'连接已断开 · 显示的是断开前的状态',error:'暂时读不到团队进度',retry:'重新连接',
 empty:'这个会话还没有启动 Pair',emptyHint:'启动 Pair 后，任务进度和团队动态会实时显示在这里。想看以前的运行，请打开当时的会话。',
 unavailable:'暂时拿不到进度',unavailableHint:'会话数据还没加载完，这不代表没有进展。',
 legacy:'页面比正在运行的团队服务新，部分内容暂时看不到',legacyHint:'重启 DSH 后就会出现，不需要重建团队。',
 overview:'总览',tasks:'任务',activity:'动态',display:'显示设置',comfortable:'宽松',compact:'紧凑',pause:'暂停刷新',resume:'恢复刷新',
 done:'已完成',total:'个任务',acceptance:'已满足的需求',gate:'质量检查通过',integration:'已合并到主线',progressHint:'已完成的任务 / 全部任务',
 current:'团队待办',clear:'团队暂时没有待办',clearHint:'有新的待办时会自动出现在这里。',action:'下一步',
 team:'团队成员',pm:'新发现的需求',awaiting:'待评估',deferred:'已搁置',workflow:'任务列表',search:'搜索任务或成员',all:'全部',active:'进行中',blocked:'受阻',completed:'已完成',
 previous:'上一页',next:'下一页',rows:'个任务',noTasks:'没有符合条件的任务',noTasksHint:'换个关键词或筛选条件试试。',unassigned:'未分配',depends:'依赖',noDeps:'无依赖',
 oracle:'验收标准已定',recorded:'已完成',pending:'未完成',detail:'任务详情',back:'关闭',criteria:'完成标准',design:'设计说明',responsibility:'职责',approach:'做法',failure:'出错时',contract:'约定',
 cyclesHistory:'开发轮次',repairs:'修正检查命令',history:'最近动态',noHistory:'还没有动态',knownState:'来自团队记录',warning:'部分数据没有读全，页面上没显示的不代表没有进展。',
 single:'单线开发',dual:'双线并行开发',updated:'更新于',readOnly:'只读 · 不影响团队运行',mailbox:'排队中的消息',mailboxHint:'还在排队、尚未交给成员处理的消息。',unknown:'无记录',goal:'目标',
 'stage.queued':'待开始','stage.draft':'待评估','stage.blocked':'等待其他任务','stage.rework':'需要返工','stage.spec':'制定验收标准','stage.coding':'开发中','stage.review':'检查中','stage.gate':'质量检查','stage.integration':'合并中','stage.completion':'收尾中','stage.done':'已完成','stage.failed':'失败','stage.cancelled':'已取消',
 'phase.FORMING':'组建团队','phase.TASK_GATE':'质量检查','phase.PLANNING':'规划中','phase.CYCLING':'开发中','phase.RETRO':'总结中','phase.DONE':'已完成','phase.ABORTED':'已中止',
 'event.created':'新建任务','event.cycle':'开始一轮开发','event.accept':'检查通过','event.reject':'检查未通过','event.checkpoint':'阶段检查通过','event.integrated':'已合并','event.completed':'任务完成','event.repair':'修正检查命令',
 risks:'风险',noRisks:'暂无风险',gateHint:'这里只显示记录的结果；代码有改动后需要重新检查。',evidence:'技术细节',
 'member.working':'工作中','member.idle':'空闲','member.ready':'就绪','member.parked':'已暂停','member.removed':'已离开',
 'action.pair_task_claim':'领取下一个任务','action.pair_oracle':'制定验收标准','action.pair_propose':'提出实现方案','action.pair_green':'提交实现和测试结果','action.pair_verify':'检查改动是否正确','action.pair_gate_check':'运行质量检查','action.pair_integrate':'合并到主线','action.pair_task_update':'确认任务完成','action.pair_backlog':'评估新发现的需求','action.pair_arbitrate':'对分歧做出决定','action.risk':'处理阻碍进度的风险',
 'action.pair_report':'完成实现并提交测试结果','action.pair_review':'审查实现方案','action.pair_red':'写出能复现问题的测试','action.pair_refactor':'整理代码，保持测试通过','action.pair_oracle_write':'为下一个任务制定验收标准',
 'attention.blocking-risk':'处理风险，处理完才能收尾','attention.stale-credential':'代码有改动，需要重新做质量检查','attention.truncated-seat':'有成员中断了，需要恢复','attention.disclosure':'成员提出了拿不准的地方，需要做决定','attention.unsunk-residual':'还有遗留问题没安排处理',
 seatHistory:'成员重启记录',seatHistoryHint:'每位成员显示最近 12 次；较早的运行可能没有记录。','replacement.recovery':'出错后恢复','replacement.accepted-cycle':'按计划重启','replacement.unknown':'原因未知',
 milestoneProgress:'整体进度',milestoneHint:'按每个仍在进行的任务要经过的六个阶段计算；新增任务或返工时可能回落。','terminated.pre':'另有 ','terminated.post':' 张已终止，不计入百分比。',milestones:'各阶段进度',acceptedIncrements:'项已通过检查',
 eta:'预计剩余',minutes:'分钟',etaRough:'按最近的检查节奏估算，每个开发步骤都会重算，期间按活跃时间倒数，仅供参考','eta.samples':'第一轮检查通过后开始估算','eta.stopped':'团队已停止，不再估算','eta.blocked':'有任务被拦下或团队已停止，暂不估算','eta.unknown':'暂时无法估算','eta.complete':'全部完成','eta.about':'约','eta.rounds':'还需约','eta.roundsUnit':'轮','active.total':'活跃总时长','active.hint':'按记录到的活动时间累计，超过 45 分钟的空闲不计入','rhythm.pace':'每轮用时','eta.held':'这一轮比平均慢，等下一步再更新',features:'功能清单','features.title':'功能清单','features.hint':'开工时登记的功能与验收条目，逐条汇总负责的任务和验收测试。验收测试按整张任务执行，所以“所在任务已完成”不等于这一条单独通过。','features.empty':'这个团队开工时没有登记功能清单','features.emptyHint':'较早的团队没有逐条验收条目，进度请看任务列表。','features.cases':'个用例','features.sep':'：','features.open':'查看功能清单','fstage.unallocated':'未分配','fstage.allocated':'已分配任务','fstage.oracle':'验收测试已冻结','fstage.done':'所在任务已完成','fstage.merging':'待合并',
 'milestone.0':'验收标准已定','milestone.1':'已开始开发','milestone.2':'开发已提交','milestone.3':'审查已通过','milestone.4':'质量检查已通过','milestone.5':'已完成',
 'event.oracle':'制定验收标准','event.review':'方案审查','event.red':'写出失败测试','event.green':'提交自测结果','event.report':'提交实现',
 'errorHint.route':'面板服务还没就绪。等当前任务结束后重启 DSH 并刷新页面即可，不需要重建团队。','errorHint.auth':'登录状态已失效，请重新打开 DSH 页面。','errorHint.read':'读取团队进度时出错。团队本身不受影响，如果一直出现可以查看日志。','errorHint.connection':'暂时连不上，正在自动重试。',
 'current.hint':'由团队自动推进，不需要你操作','who.captain':'队长',
 value:'把关成效','value.title':'审查与挑战带来的改变','value.hint':'只统计看板上记录的把关动作；这些动作是否避免了缺陷，单凭记录无法证明。',
 'value.noGo':'开工前退回方案','value.rejects':'验证时拦下','value.fixed':'拦下后修好通过','value.repairs':'修正检查命令',
 'value.navigator':'审查 · Navigator','value.challenger':'挑战 · Challenger','value.oracles':'冻结的验收标准','value.casesUnit':'条','value.tasksUnit':'个任务',
 'value.firstTry':'一次通过的轮次','value.scope':'发现超出需求的改动','value.preexisting':'指出牵连已有功能','value.risksRaised':'提出的风险','value.reasons':'拦下的原因','value.noReasons':'还没有拦下记录',
 'value.noNavigator':'这个团队没有审查席位。','value.noChallenger':'这个团队没有挑战者席位。','value.handled':'已处理','value.open':'待处理','value.dismissed':'不处理',
 'value.notes':'把关记录','value.empty':'还没有把关记录','who.navigator':'审查','who.challenger':'挑战',
 'note.noGo':'退回方案','note.reject':'验证拒绝','note.repair':'修正检查命令','note.scope':'超出需求','note.preexisting':'牵连已有功能','note.fixed':'拦下后修好','note.risk':'提出风险','note.fixedPre':'被拦下 ','note.fixedPost':' 次后通过',
 'reason.checkpoint_red':'阶段检查没通过','reason.oracle_red':'验收测试没通过','reason.oracle_timeout':'验收测试超时','reason.oracle_tampered':'验收标准被改动','reason.reviewer_reject':'审查者否决',
 'reason.invest_violation':'任务拆分不当','reason.test_first_violation':'没有先写测试','reason.risk_hit':'触发已知风险','reason.quality':'质量问题','reason.other':'其他',
 rhythm:'工作节奏','rhythm.recentPre':'最近 ','rhythm.recentPost':' 条动态','rhythm.passRate':'检查通过率','rhythm.idle':'空闲','rhythm.byTask':'各任务动态','rhythm.other':'其他任务','rhythm.undatedPre':'另有 ','rhythm.undatedPost':' 次未通过没有记录时间',
 'group.plan':'规划','group.build':'开发','group.pass':'通过','group.fail':'未通过','event.verified':'已验证',
 'duration.lt1':'不到 1 分钟','duration.h':'小时','duration.m':'分',
 'work.label':'已工作','work.turn':'本轮已工作','work.unknown':'工作时长未记录','work.hint':'只统计成员实际在工作的时间',
 effort:'推理','effort.default':'默认','effort.none':'关闭','effort.minimal':'最低','effort.low':'低','effort.medium':'中','effort.high':'高','effort.xhigh':'超高','effort.max':'最高','model.unknown':'模型未记录'
};
var PAIR_PANEL_EN={
 tab:'Pair runtime',guide:'What the team is doing, how far along it is, and whether anything is stuck',title:'Goal progress',live:'Live',loading:'Connecting',paused:'Refresh paused',stale:'Disconnected · showing the last known state',error:"Can't load team progress",retry:'Reconnect',
 empty:"Pair hasn't started in this session",emptyHint:'Once Pair starts, task progress and team activity appear here live. For earlier runs, open the session they ran in.',
 unavailable:'Progress unavailable right now',unavailableHint:"Session data is still loading. That doesn't mean nothing has happened.",
 legacy:'This page is newer than the running team service, so some sections are hidden',legacyHint:'They appear after DSH is restarted. The team does not need to be recreated.',
 overview:'Overview',tasks:'Tasks',activity:'Activity',display:'Display',comfortable:'Comfortable',compact:'Compact',pause:'Pause refresh',resume:'Resume refresh',
 done:'Done',total:'tasks',acceptance:'Requirements met',gate:'Passed quality check',integration:'Merged into main',progressHint:'Finished tasks / all tasks',
 current:'Team to-dos',clear:'No team to-dos right now',clearHint:'New to-dos show up here automatically.',action:'Next step',
 team:'Team',pm:'New requests found',awaiting:'to review',deferred:'set aside',workflow:'Tasks',search:'Search tasks or members',all:'All',active:'In progress',blocked:'Blocked',completed:'Done',
 previous:'Previous',next:'Next',rows:'tasks',noTasks:'No matching tasks',noTasksHint:'Try a different search or filter.',unassigned:'Unassigned',depends:'Depends on',noDeps:'No dependencies',
 oracle:'Acceptance criteria set',recorded:'Done',pending:'Not yet',detail:'Task details',back:'Close',criteria:'Done when',design:'Design notes',responsibility:'Responsibility',approach:'Approach',failure:'On failure',contract:'Agreement',
 cyclesHistory:'Work rounds',repairs:'Check command fixed',history:'Recent activity',noHistory:'No activity yet',knownState:'From team records',warning:"Some data couldn't be fully read. Anything missing here isn't necessarily missing progress.",
 single:'Single track',dual:'Two parallel tracks',updated:'Updated',readOnly:"Read-only · doesn't affect the team",mailbox:'Queued messages',mailboxHint:'Messages still waiting to be handed to each member.',unknown:'No record',goal:'Goal',
 'stage.queued':'Not started','stage.draft':'To review','stage.blocked':'Waiting on other tasks','stage.rework':'Needs rework','stage.spec':'Setting acceptance criteria','stage.coding':'In development','stage.review':'Being checked','stage.gate':'Quality check','stage.integration':'Merging','stage.completion':'Wrapping up','stage.done':'Done','stage.failed':'Failed','stage.cancelled':'Cancelled',
 'phase.FORMING':'Assembling team','phase.TASK_GATE':'Quality check','phase.PLANNING':'Planning','phase.CYCLING':'Building','phase.RETRO':'Reviewing','phase.DONE':'Done','phase.ABORTED':'Stopped',
 'event.created':'Task added','event.cycle':'Work round started','event.accept':'Check passed','event.reject':'Check failed','event.checkpoint':'Stage check passed','event.integrated':'Merged','event.completed':'Task done','event.repair':'Check command fixed',
 risks:'Risks',noRisks:'No risks',gateHint:'Shows recorded results only; code changes need a fresh check.',evidence:'Technical details',
 'member.working':'Working','member.idle':'Idle','member.ready':'Ready','member.parked':'Paused','member.removed':'Left',
 'action.pair_task_claim':'Pick up the next task','action.pair_oracle':'Set acceptance criteria','action.pair_propose':'Propose an approach','action.pair_green':'Submit the implementation and test results','action.pair_verify':'Check that the changes are correct','action.pair_gate_check':'Run the quality check','action.pair_integrate':'Merge into main','action.pair_task_update':'Confirm the task is done','action.pair_backlog':'Review newly found requests','action.pair_arbitrate':'Decide on a disagreement','action.risk':'Handle a risk that blocks progress',
 'action.pair_report':'Finish the implementation and submit test results','action.pair_review':'Review the proposed approach','action.pair_red':'Write a test that reproduces the problem','action.pair_refactor':'Tidy the code while tests keep passing','action.pair_oracle_write':'Set acceptance criteria for the next task',
 'attention.blocking-risk':'Resolve risks before wrap-up','attention.stale-credential':'The code changed, so the quality check must run again','attention.truncated-seat':'A member was interrupted and needs to resume','attention.disclosure':'A member flagged something uncertain and needs a decision','attention.unsunk-residual':'Leftover issues still need an owner',
 seatHistory:'Member restarts',seatHistoryHint:'Latest 12 per member; older runs may have no records.','replacement.recovery':'Recovered after an error','replacement.accepted-cycle':'Planned restart','replacement.unknown':'Unknown reason',
 milestoneProgress:'Overall progress',milestoneHint:'Counts the six stages every task still in play goes through; it can drop when tasks are added or reworked.','terminated.pre':'Another ','terminated.post':' stopped card(s), outside the percentage.',milestones:'Stage progress',acceptedIncrements:'passed checks',
 eta:'Time left',minutes:'min',etaRough:'Based on the recent check pace, recalculated at every step and counted down with active time in between; a rough guide only','eta.samples':'An estimate appears after the first passed check','eta.stopped':'The team has stopped, so no estimate','eta.blocked':'A stopped task or a stopped team pauses the estimate','eta.unknown':'No estimate available','eta.complete':'All done','eta.about':'about','eta.rounds':'About','eta.roundsUnit':'rounds to go','active.total':'Active time','active.hint':'Recorded activity, leaving out idle stretches longer than 45 minutes','rhythm.pace':'Per round','eta.held':'This round is slower than average; waiting for the next step',features:'Features','features.title':'Feature list','features.hint':'Features and acceptance criteria registered at kickoff, each rolled up from its tasks and acceptance tests. Acceptance tests run per task, so "task done" does not mean this criterion passed on its own.','features.empty':'This team registered no feature list at kickoff','features.emptyHint':'Older teams have no per-criterion list; use the task list for progress.','features.cases':'use cases','features.sep':': ','features.open':'Open feature list','fstage.unallocated':'Not assigned','fstage.allocated':'Assigned','fstage.oracle':'Acceptance tests frozen','fstage.done':'Task done','fstage.merging':'Awaiting merge',
 'milestone.0':'Acceptance criteria set','milestone.1':'Development started','milestone.2':'Development submitted','milestone.3':'Review passed','milestone.4':'Quality check passed','milestone.5':'Done',
 'event.oracle':'Acceptance criteria set','event.review':'Approach reviewed','event.red':'Failing test written','event.green':'Submitted self-test results','event.report':'Implementation submitted',
 'errorHint.route':"The panel service isn't ready yet. Once current work finishes, restart DSH and refresh this page. The team doesn't need to be recreated.",'errorHint.auth':'Your sign-in has expired. Reopen the DSH page.','errorHint.read':"Couldn't read team progress. The team itself is unaffected; check the logs if this keeps happening.",'errorHint.connection':"Can't connect right now; retrying automatically.",
 'current.hint':'Handled by the team automatically; nothing for you to do','who.captain':'Captain',
 value:'Review impact','value.title':'What review and challenge changed','value.hint':'Counts only the review actions recorded on the board; whether they prevented a defect cannot be proven from the record alone.',
 'value.noGo':'Proposals sent back','value.rejects':'Stopped at verification','value.fixed':'Fixed after pushback','value.repairs':'Check commands fixed',
 'value.navigator':'Review · Navigator','value.challenger':'Challenge · Challenger','value.oracles':'Frozen acceptance criteria','value.casesUnit':'cases','value.tasksUnit':'tasks',
 'value.firstTry':'Rounds passed first time','value.scope':'Out-of-scope changes caught','value.preexisting':'Existing features at risk','value.risksRaised':'Risks raised','value.reasons':'Why work was stopped','value.noReasons':'Nothing stopped yet',
 'value.noNavigator':'This team has no review seat.','value.noChallenger':'This team has no challenger seat.','value.handled':'Handled','value.open':'Open','value.dismissed':'Dismissed',
 'value.notes':'Review log','value.empty':'No review actions recorded yet','who.navigator':'Review','who.challenger':'Challenge',
 'note.noGo':'Proposal sent back','note.reject':'Rejected at verification','note.repair':'Check command fixed','note.scope':'Out of scope','note.preexisting':'Existing feature at risk','note.fixed':'Fixed after pushback','note.risk':'Risk raised','note.fixedPre':'Passed after ','note.fixedPost':' pushback(s)',
 'reason.checkpoint_red':'Step check failed','reason.oracle_red':'Acceptance tests failed','reason.oracle_timeout':'Acceptance tests timed out','reason.oracle_tampered':'Acceptance criteria altered','reason.reviewer_reject':'Reviewer veto',
 'reason.invest_violation':'Poorly sliced task','reason.test_first_violation':'Tests not written first','reason.risk_hit':'Hit a known risk','reason.quality':'Quality issue','reason.other':'Other',
 rhythm:'Work rhythm','rhythm.recentPre':'Latest ','rhythm.recentPost':' events','rhythm.passRate':'Check pass rate','rhythm.idle':'Idle','rhythm.byTask':'Events by task','rhythm.other':'Other tasks','rhythm.undatedPre':'Another ','rhythm.undatedPost':' pushback(s) have no recorded time',
 'group.plan':'Planning','group.build':'Building','group.pass':'Passed','group.fail':'Failed','event.verified':'Verified',
 'duration.lt1':'<1 min','duration.h':'h','duration.m':'min',
 'work.label':'Worked','work.turn':'This turn','work.unknown':'Work time not recorded','work.hint':'Counts only the time this member was actually working',
 effort:'Reasoning','effort.default':'default','effort.none':'off','effort.minimal':'minimal','effort.low':'low','effort.medium':'medium','effort.high':'high','effort.xhigh':'extra high','effort.max':'max','model.unknown':'Model not recorded'
};
function pairPanelErrorHint(error){
 var text=String(error||'');
 return /HTTP (404|405)\b/.test(text)?'errorHint.route':/HTTP (401|403)\b/.test(text)?'errorHint.auth':text==='pair-panel/read'?'errorHint.read':'errorHint.connection';
}
// Activity groups: planning -> building -> passed is an ordered pipeline (one-hue ramp); failed wears the warning status.
var PAIR_RHYTHM_GROUPS=['plan','build','pass','fail'];
function pairRhythmGroup(kind){return kind==='created'||kind==='oracle'?'plan':['reject','noGo'].includes(kind)?'fail':['accept','checkpoint','integrated','completed'].includes(kind)?'pass':'build';}
// Splits events into work bursts at idle gaps; the gap widens until at most maxSegments bursts remain.
function pairRhythm(events,options){
 options=options||{};var maxSegments=options.maxSegments||6,gap=options.gapMs||45*60000,segments;
 var list=(events||[]).filter(function(e){return e&&Number.isFinite(e.at);}).slice().sort(function(a,b){return a.at-b.at;});
 for(;;){
  segments=[];
  list.forEach(function(e){var s=segments[segments.length-1];if(!s||e.at-s.end>gap){s={start:e.at,end:e.at,events:[]};segments.push(s);}s.end=e.at;s.events.push(e);});
  if(segments.length<=maxSegments)break;gap*=2;
 }
 var counts={plan:0,build:0,pass:0,fail:0},tasks={},cycles=0,accepted=0,rejected=0;
 list.forEach(function(e){
  var g=pairRhythmGroup(e.kind);counts[g]++;if(e.kind==='cycle')cycles++;if(e.kind==='accept'||e.kind==='checkpoint')accepted++;if(e.kind==='reject')rejected++;
  var row=tasks[e.ref]||(tasks[e.ref]={ref:e.ref,total:0,plan:0,build:0,pass:0,fail:0});row.total++;row[g]++;
 });
 var rows=Object.keys(tasks).map(function(k){return tasks[k];}).sort(function(a,b){return b.total-a.total||String(a.ref).localeCompare(String(b.ref),undefined,{numeric:true});});
 var other=rows.slice(6).reduce(function(o,r){o.total+=r.total;o.count++;PAIR_RHYTHM_GROUPS.forEach(function(g){o[g]+=r[g];});return o;},{ref:null,count:0,total:0,plan:0,build:0,pass:0,fail:0});
 return {total:list.length,segments:segments,counts:counts,cycles:cycles,
  passRate:accepted+rejected?accepted/(accepted+rejected):null,tasks:rows.slice(0,6),other:other.count?other:null};
}
function pairDuration(ms,t){
 if(!Number.isFinite(ms)||ms<0)return '';
 var min=Math.floor(ms/60000);if(min<1)return t('duration.lt1');if(min<60)return min+' '+t('minutes');
 var hours=Math.floor(min/60),rest=min%60;return hours+' '+t('duration.h')+(rest?' '+rest+' '+t('duration.m'):'');
}
// Mirrors the scheduler's accumulator: an open turn counts to now, or to one working lease past its last activity.
function pairWorkMs(member,leaseMs,now){
 var recorded=Number.isFinite(member.workMs)&&member.workMs>=0?member.workMs:null,since=member.workingSince;
 if(!Number.isFinite(since))return {ms:recorded,live:false};
 var lease=leaseMs>0?leaseMs:Infinity,seen=Math.max(since,Number.isFinite(member.lastActivityAt)?member.lastActivityAt:since);
 return {ms:(recorded||0)+Math.max(0,Math.min(now,seen+lease)-since),live:now-seen<lease};
}
// One to-do per seat and kind of work, with every reference it covers.
function pairAttentionGroups(items){
 var groups=[],index={};
 (items||[]).forEach(function(a){
  var key=a.who+'|'+(a.kind||'')+'|'+(a.tool||''),g=index[key];
  if(!g){g=index[key]={key:key,who:a.who,kind:a.kind,tool:a.tool,refs:[],why:[]};groups.push(g);}
  if(a.ref)g.refs.push(a.ref);if(a.why)g.why.push(a.why);
 });
 return groups;
}
// A browser page can outlive a host restart: when the page is newer than the running service, fields it
// never sent arrive missing. Missing is not empty — an old projection has no 'features' key at all, while a
// new one always sends the list (empty when nothing was registered).
function pairLegacyServer(team){return !!team&&!('features' in team);}
// The pre-0.15.12 projection reported a range, not one number; render what it actually measured.
function pairEtaRange(eta){
 var lo=eta&&Number.isFinite(eta.minMinutes)?eta.minMinutes:null;
 if(lo===null)return null;var hi=Number.isFinite(eta.maxMinutes)?eta.maxMinutes:lo;
 return {lo:lo,hi:Math.max(lo,hi)};
}
// A panel that loses the board and finds it again must not roll the number back through 0 first: the
// card did not change, and the user reads the drop as lost work (measured on SG-career, where the
// disc fell to 0% on every re-read). A real 0 is still a 0.
function pairSteadyPercent(progress,previous){
 if(progress&&Number.isFinite(progress.percent))return progress.percent;
 return Number.isFinite(previous)?previous:0;
}
// Counts an estimate down with the time since its latest step while the team is live and inside the idle gap;
// the part for rounds not yet opened is never counted down.
function pairEtaMs(eta,gapMs,now,running){
 var total=(eta.minutes||0)*60000,floor=(Number.isFinite(eta.floorMinutes)?eta.floorMinutes:(eta.minutes||0))*60000;
 var elapsed=running&&Number.isFinite(eta.at)&&now>=eta.at&&now-eta.at<(gapMs>0?gapMs:Infinity)?now-eta.at:0;
 return {ms:Math.max(floor,total-elapsed),ticking:elapsed>0,held:elapsed>0&&total>floor&&total-elapsed<=floor};
}
// Feature stages in order; "done" means the task holding the criterion completed, not that the criterion passed alone.
var PAIR_FEATURE_STAGES=['unallocated','allocated','oracle','done'];
function pairFeatureStage(c){return c.completed?'done':c.oracle?'oracle':c.tasks&&c.tasks.length?'allocated':'unallocated';}
function createPairDashboard(React){
 var h=React.createElement;
 function reducedMotion(){try{return typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){return false;}}
 function Chip(p){return h('span',{className:'pair-pill pair-tone-'+(p.tone||'neutral')+(p.busy?' is-busy':'')},p.children);}
 function tone(stage){return stage==='done'?'good':['blocked','rework','failed'].includes(stage)?'warn':['queued','draft','cancelled'].includes(stage)?'neutral':'active';}
 function Stamp(p){return h('time',{dateTime:new Date(p.at).toISOString(),title:new Date(p.at).toLocaleString()},new Date(p.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));}
 function Bar(p){var ratio=p.total?Math.min(1,p.value/p.total):0;return h('div',{className:'pair-meter',role:'progressbar','aria-label':p.label,'aria-valuemin':0,'aria-valuemax':p.total||1,'aria-valuenow':p.value},h('i',{className:ratio>0&&ratio<1?'is-flowing':undefined,style:{width:ratio*100+'%'}}));}
 function explain(t,a){var kind='attention.'+a.kind,key='action.'+a.tool;return t(kind)!==kind?t(kind):t(key)!==key?t(key):t('action');}
 // Team active time: the board's recorded activity, extended to now while the team is live and inside the idle gap.
 function ActiveTime(p){
  var a=p.active,tick=React.useState(0)[1],now=Date.now(),live=!!p.running&&Number.isFinite(a.lastAt)&&now>=a.lastAt&&now-a.lastAt<a.gapMs;
  React.useEffect(function(){if(!live)return;var id=setInterval(function(){tick(function(n){return n+1;});},20000);return function(){clearInterval(id);};},[live]);
  return h('span',{className:'pair-eta pair-active'+(live?' is-live':''),title:p.t('active.hint')},h('i',{className:'pair-clock','aria-hidden':'true'}),p.t('active.total')+' '+pairDuration(a.activeMs+(live?now-a.lastAt:0),p.t));
 }
 // Remaining time: recalculated at every step and counted down with active time in between; the tooltip names its basis.
 function Eta(p){
  var e=p.eta,t=p.t,range=pairEtaRange(e),rough=e.reason==='rough',tick=React.useState(0)[1];
  var left=rough?pairEtaMs(e,p.gapMs,Date.now(),!!p.running):null,ticking=!!(left&&left.ticking);
  React.useEffect(function(){if(!ticking)return;var id=setInterval(function(){tick(function(n){return n+1;});},20000);return function(){clearInterval(id);};},[ticking]);
  // An older projection measured a range and left no step timestamp to count down from, so show what it said.
  if(range)return h('span',{className:'pair-eta is-rough',title:t('etaRough')},h('i',{className:'pair-eta-mark','aria-hidden':'true'}),
   t('eta')+' '+t('eta.about')+' '+range.lo+(range.hi>range.lo?'–'+range.hi:'')+' '+t('minutes'));
  var key='eta.'+e.reason,label=t(key)!==key?t(key):t('eta.unknown');
  var basis=rough?t('etaRough')+' · '+t('eta.rounds')+' '+e.rounds+' '+t('eta.roundsUnit')+' · '+t('rhythm.pace')+' '+pairDuration(e.paceMs,t)
   +(Number.isFinite(e.at)?' · '+t('updated')+' '+new Date(e.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'')+(left.held?' · '+t('eta.held'):''):undefined;
  return h('span',{className:'pair-eta'+(rough?' is-rough':'')+(left&&left.held?' is-held':''),title:basis},h('i',{className:'pair-eta-mark','aria-hidden':'true'}),
   rough?t('eta')+' '+t('eta.about')+' '+pairDuration(left.ms,t):label);
 }
 // Feature list: every goal acceptance criterion rolled up from its task cards and frozen acceptance tests.
 function Features(p){
  var t=p.t,list=p.features||[],all=[];
  list.forEach(function(u){all=all.concat(u.criteria);});
  if(p.legacy)return h('div',{className:'pair-section pair-inline-empty'},h('strong',null,t('legacy')),h('p',null,t('legacyHint')));
  if(!all.length)return h('div',{className:'pair-section pair-inline-empty'},h('strong',null,t('features.empty')),h('p',null,t('features.emptyHint')));
  var counts={unallocated:0,allocated:0,oracle:0,done:0},order=['done','oracle','allocated','unallocated'];
  all.forEach(function(c){counts[pairFeatureStage(c)]++;});
  return h('div',{className:'pair-features'},
   h('div',{className:'pair-value-intro'},h('h2',null,t('features.title')),h('p',null,t('features.hint'))),
   h('section',{className:'pair-section pair-feature-summary'},
    h('div',{className:'pair-section-head'},h('h2',null,h(Num,{value:counts.done}),' / '+all.length+' '+t('fstage.done')),h('span',{className:'pair-muted'},list.length+' '+t('features.cases'))),
    h('div',{className:'pair-feature-bar',role:'img','aria-label':order.map(function(s){return t('fstage.'+s)+' '+counts[s];}).join(' · ')},
     order.filter(function(s){return counts[s]>0;}).map(function(s){return h('i',{key:s,className:'is-'+s,style:{flexGrow:counts[s]},title:t('fstage.'+s)+' '+counts[s]});})),
    h('div',{className:'pair-feature-legend'},order.map(function(s){return h('span',{key:s,className:'is-'+s},h('i',null),t('fstage.'+s),h('b',null,counts[s]));}))),
   list.map(function(u,ui){
    var done=u.criteria.filter(function(c){return c.completed;}).length;
    return h('section',{key:u.id,className:'pair-section pair-feature-case',style:{'--i':Math.min(ui,10)}},
     h('div',{className:'pair-section-head'},h('div',null,h('span',{className:'pair-eyebrow'},u.id),h('h2',null,u.actor+t('features.sep')+u.intent),h('p',{className:'pair-section-sub'},'→ '+u.outcome)),
      h(Chip,{tone:done===u.criteria.length?'good':'neutral'},done+' / '+u.criteria.length)),
     h('ol',{className:'pair-feature-list'},u.criteria.map(function(c,i){
      var stage=pairFeatureStage(c),reached=PAIR_FEATURE_STAGES.indexOf(stage);
      return h('li',{key:c.id,className:'is-'+stage,style:{'--i':Math.min(i,14)}},
       h('span',{className:'pair-feature-steps','aria-hidden':'true'},[1,2,3].map(function(n){return h('i',{key:n,className:n<=reached?'is-on':undefined});})),
       h('div',{className:'pair-feature-main'},h('p',null,c.text),
        h('div',{className:'pair-feature-meta'},h('code',null,c.id),h('span',{className:'pair-feature-stage'},t('fstage.'+stage)),
         p.parallel&&c.completed&&!c.integrated&&h('span',{className:'pair-feature-stage is-merge'},t('fstage.merging')),
         c.tasks.map(function(id){return h('button',{key:id,type:'button',className:'pair-feature-task',disabled:p.paused,onClick:function(){p.openTask(id);}},id);}))));
     })));
   }));
 }
 // Review impact: recorded pushback, fixes and risks from the independent seats. Counts and quotes only, nothing inferred.
 function Value(p){
  var v=p.value,t=p.t;
  if(p.legacy)return h('div',{className:'pair-inline-empty'},h('strong',null,t('legacy')),h('p',null,t('legacyHint')));
  if(!v)return h('div',{className:'pair-inline-empty'},h('strong',null,t('value.empty')));
  function who(role){return t('who.'+role);}
  function reason(key){var k='reason.'+key;return t(k)!==k?t(k):key;}
  var maxReason=v.reasons.length?v.reasons[0].count:1,cr=v.risks.challenger;
  var maxRisk=Math.max(1,...cr.bySeverity.map(function(s){return s.handled+s.open+s.dismissed;}));
  var nav=v.roles.navigator?h('section',{className:'pair-section pair-value-card'},
   h('div',{className:'pair-section-head'},h('h2',null,t('value.navigator')),h('span',{className:'pair-avatar is-navigator'},'N')),
   h('dl',{className:'pair-value-facts'},[[t('value.oracles'),v.oracles.cases+' '+t('value.casesUnit')+' · '+v.oracles.tasks+' '+t('value.tasksUnit')],
    [t('value.firstTry'),v.settled?v.firstTry+' / '+v.settled:'—'],[t('value.scope'),v.scope],[t('value.preexisting'),v.preexisting],[t('value.risksRaised'),v.risks.navigator.total]]
    .map(function(f){return h('div',{key:f[0]},h('dt',null,f[0]),h('dd',null,f[1]));})),
   h('h3',null,t('value.reasons')),
   v.reasons.length?h('div',{className:'pair-value-bars'},v.reasons.map(function(r,i){return h('div',{key:r.key,className:'pair-value-bar',style:{'--i':i}},
    h('span',{title:reason(r.key)},reason(r.key)),h('div',{className:'pair-value-track'},h('i',{style:{width:r.count/maxReason*100+'%'}})),h('b',null,r.count));})):h('p',{className:'pair-muted'},t('value.noReasons')))
   :h('section',{className:'pair-section pair-value-card is-empty'},h('h2',null,t('value.navigator')),h('p',{className:'pair-muted'},t('value.noNavigator')));
  var chal=v.roles.challenger?h('section',{className:'pair-section pair-value-card'},
   h('div',{className:'pair-section-head'},h('h2',null,t('value.challenger')),h('span',{className:'pair-avatar is-challenger'},'C')),
   h('dl',{className:'pair-value-facts'},h('div',null,h('dt',null,t('value.risksRaised')),h('dd',null,cr.total))),
   h('div',{className:'pair-value-legend'},['handled','open','dismissed'].map(function(k){return h('span',{key:k,className:'is-'+k},h('i',null),t('value.'+k));})),
   h('div',{className:'pair-value-bars'},cr.bySeverity.map(function(s,i){var n=s.handled+s.open+s.dismissed;return h('div',{key:s.severity,className:'pair-value-bar',style:{'--i':i}},h('span',null,s.severity),
    h('div',{className:'pair-value-track'},n>0&&h('div',{className:'pair-value-stack',style:{width:n/maxRisk*100+'%'}},['handled','open','dismissed'].filter(function(k){return s[k]>0;}).map(function(k){return h('i',{key:k,className:'is-'+k,style:{flexGrow:s[k]},title:t('value.'+k)+' '+s[k]});}))),
    h('b',null,n));})))
   :h('section',{className:'pair-section pair-value-card is-empty'},h('h2',null,t('value.challenger')),h('p',{className:'pair-muted'},t('value.noChallenger')));
  return h('div',{className:'pair-value'},
   h('div',{className:'pair-value-intro'},h('h2',null,t('value.title')),h('p',null,t('value.hint'))),
   h('div',{className:'pair-metrics pair-value-kpis'},[[t('value.noGo'),v.noGo],[t('value.rejects'),v.rejects],[t('value.fixed'),v.fixedAfterPushback],[t('value.repairs'),v.repairs]]
    .map(function(k){return h('div',{key:k[0]},h('span',null,k[0]),h('strong',null,h(Num,{value:k[1]})));})),
   h('div',{className:'pair-value-grid'},nav,chal),
   h('section',{className:'pair-section'},h('div',{className:'pair-section-head'},h('h2',null,t('value.notes')),h('span',{className:'pair-muted'},v.notes.length)),
    v.notes.length?h('ol',{className:'pair-value-notes'},v.notes.map(function(n,i){return h('li',{key:n.kind+'|'+n.ref+'|'+n.at,className:'is-'+n.kind,style:{'--i':Math.min(i,14)}},
     h(Stamp,{at:n.at}),h('span',{className:'pair-who'},who(n.role)),
     h('div',null,h('strong',null,t('note.'+n.kind)+(n.severity?' '+n.severity:'')),h('code',null,n.task&&n.task!==n.ref?n.task+' · '+n.ref:n.ref),
      n.kind==='fixed'?h('p',null,t('note.fixedPre')+n.count+t('note.fixedPost')):n.text&&h('p',null,n.text)));}))
    :h('div',{className:'pair-inline-empty'},h('strong',null,t('value.empty')))));
 }
 // Worked time ticks locally while the open turn is still inside its lease.
 function WorkTime(p){
  var m=p.member,tick=React.useState(0)[1],work=pairWorkMs(m,p.lease,Date.now());
  React.useEffect(function(){if(!work.live)return;var id=setInterval(function(){tick(function(n){return n+1;});},20000);return function(){clearInterval(id);};},[work.live]);
  if(work.ms===null)return h('span',{className:'pair-worktime is-unknown'},p.t('work.unknown'));
  return h('span',{className:'pair-worktime'+(work.live?' is-live':''),title:p.t('work.hint')},h('i',{className:'pair-clock','aria-hidden':'true'}),(Number.isFinite(m.workMs)?p.t('work.label'):p.t('work.turn'))+' '+pairDuration(work.ms,p.t));
 }
 // Activity chart: one lane per group on a time axis whose idle gaps are cut out and labelled.
 function Rhythm(p){
  var t=p.t,box=React.useRef(null),ws=React.useState(0),width=ws[0],setWidth=ws[1],hs=React.useState(null),hover=hs[0],setHover=hs[1];
  var data=React.useMemo(function(){return pairRhythm(p.events);},[p.events]);
  React.useLayoutEffect(function(){
   var node=box.current;if(!node)return;
   function measure(){setWidth(Math.round(node.clientWidth));}
   measure();if(typeof ResizeObserver!=='function')return;
   var ro=new ResizeObserver(measure);ro.observe(node);return function(){ro.disconnect();};
  },[]);
  function clock(at){return new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
  var groups=PAIR_RHYTHM_GROUPS,labelW=width<420?44:60,top=24,laneH=30,axisH=24,breakW=36,right=6;
  var height=top+groups.length*laneH+axisH,plotW=Math.max(0,width-labelW-right),segs=data.segments;
  var avail=Math.max(0,plotW-breakW*Math.max(0,segs.length-1)),span=segs.reduce(function(n,s){return n+s.end-s.start;},0);
  var floor=Math.max(span*0.08,5*60000),weights=segs.map(function(s){return Math.max(s.end-s.start,floor);}),sum=weights.reduce(function(a,b){return a+b;},0)||1;
  var cursor=labelW,layout=segs.map(function(s,i){var w=avail*weights[i]/sum,seg={x:cursor,w:w,s:s};cursor+=w+breakW;return seg;});
  var dots=[],placed={},seen={},slots=[0,-7,7,-4,4];
  layout.forEach(function(seg){
   var dur=seg.s.end-seg.s.start,pad=Math.min(10,seg.w/2);
   seg.s.events.forEach(function(e){
    var g=pairRhythmGroup(e.kind),lane=groups.indexOf(g),cx=dur?seg.x+pad+(e.at-seg.s.start)/dur*(seg.w-2*pad):seg.x+seg.w/2;
    var taken=placed[g]||(placed[g]=[]),k=0,id=e.kind+'|'+e.ref+'|'+e.at;
    while(k<slots.length-1&&taken.some(function(q){return Math.abs(q.x-cx)<8&&q.o===slots[k];}))k++;
    taken.push({x:cx,o:slots[k]});seen[id]=(seen[id]||0)+1;
    dots.push({e:e,g:g,cx:cx,cy:top+lane*laneH+laneH/2+slots[k],i:dots.length,key:id+'|'+seen[id]});
   });
  });
  var latest=dots[dots.length-1],tip=hover===null?null:dots[hover];
  var plot=width>0&&dots.length>0&&h('svg',{className:'pair-rhythm-plot',width:width,height:height,role:'img','aria-label':t('rhythm')},
   layout.map(function(seg,i){return h('rect',{key:'band'+i,className:'pair-rhythm-band',x:seg.x,y:top-4,width:Math.max(2,seg.w),height:groups.length*laneH+8,rx:7});}),
   groups.map(function(g,i){var y=top+i*laneH+laneH/2;return h('g',{key:g,className:'pair-rhythm-lane is-'+g},h('text',{x:0,y:y,dy:'0.35em'},t('group.'+g)),h('line',{x1:labelW,x2:width-right,y1:y,y2:y}));}),
   layout.map(function(seg,i){
    var gap=i?seg.s.start-layout[i-1].s.end:0,gapMin=Math.floor(gap/60000),bx=seg.x-breakW/2,base=height-axisH+4;
    return h('g',{key:'axis'+i,className:'pair-rhythm-axis'},
     h('text',{x:seg.x,y:height-6},clock(seg.s.start)),
     seg.w>=100&&seg.s.end>seg.s.start&&h('text',{x:seg.x+seg.w,y:height-6,textAnchor:'end'},clock(seg.s.end)),
     i>0&&h('g',{className:'pair-rhythm-break'},h('path',{d:'M'+(bx-5)+' '+(base+4)+'l5 -10M'+(bx+1)+' '+(base+4)+'l5 -10'}),
      h('text',{x:bx,y:top-10,textAnchor:'middle'},t('rhythm.idle')+' '+(gapMin>=60?Math.round(gapMin/60)+' '+t('duration.h'):pairDuration(gap,t)))));
   }),
   dots.map(function(d){return h('g',{key:d.key,className:'pair-rhythm-dot is-'+d.g,style:{'--i':Math.min(d.i,30)}},
    d===latest&&h('circle',{className:'pair-rhythm-halo',cx:d.cx,cy:d.cy,r:4.5}),
    h('circle',{className:'pair-rhythm-mark',cx:d.cx,cy:d.cy,r:4.5}),
    h('circle',{className:'pair-rhythm-hit',cx:d.cx,cy:d.cy,r:11,tabIndex:0,'aria-label':t('event.'+d.e.kind)+' · '+d.e.ref+' · '+clock(d.e.at),
     onPointerEnter:function(){setHover(d.i);},onPointerLeave:function(){setHover(null);},onFocus:function(){setHover(d.i);},onBlur:function(){setHover(null);}}));}));
  var max=data.tasks.length?data.tasks[0].total:1,rows=data.tasks.concat(data.other?[data.other]:[]);
  return h('section',{className:'pair-section pair-rhythm'},
   h('div',{className:'pair-section-head'},h('h2',null,t('rhythm')),h('span',{className:'pair-muted'},t('rhythm.recentPre')+data.total+t('rhythm.recentPost'))),
   h('div',{className:'pair-rhythm-stats'},[[t('rhythm.pace'),p.paceMs?pairDuration(p.paceMs,t):'—'],[t('cyclesHistory'),String(data.cycles)],[t('rhythm.passRate'),data.passRate===null?'—':Math.round(data.passRate*100)+'%']].map(function(s){return h('div',{key:s[0]},h('span',null,s[0]),h('strong',null,s[1]));})),
   h('div',{className:'pair-rhythm-legend'},groups.map(function(g){return h('span',{key:g,className:'is-'+g},h('i',null),t('group.'+g),h('b',null,data.counts[g]));})),
   h('div',{ref:box,className:'pair-rhythm-canvas'},data.total?plot:h('p',{className:'pair-muted'},t('noHistory')),
    tip&&h('div',{className:'pair-rhythm-tip',style:{left:Math.max(0,Math.min(width-208,tip.cx-104))+'px',top:(tip.cy<72?tip.cy+16:tip.cy-70)+'px'}},
     h('strong',null,t('event.'+tip.e.kind)),h('span',null,tip.e.ref+' · '+tip.e.text),h('time',null,clock(tip.e.at)))),
   // A board written before the record existed kept only the count; say that instead of dropping it.
   p.undated>0&&h('p',{className:'pair-rhythm-note pair-muted'},t('rhythm.undatedPre')+p.undated+t('rhythm.undatedPost')),
   rows.length>0&&h('div',{className:'pair-rhythm-tasks'},h('h3',null,t('rhythm.byTask')),
    rows.map(function(r){return h('div',{key:r.ref===null?'other':r.ref,className:'pair-rhythm-row',title:groups.map(function(g){return t('group.'+g)+' '+r[g];}).join(' · ')},
     h('code',null,r.ref===null?t('rhythm.other')+' ('+r.count+')':r.ref),
     h('div',{className:'pair-rhythm-track'},h('div',{className:'pair-rhythm-bar',style:{width:Math.min(100,r.total/max*100)+'%'}},groups.filter(function(g){return r[g]>0;}).map(function(g){return h('i',{key:g,className:'is-'+g,style:{flexGrow:r[g]}});}))),
     h('b',null,r.total));})));
 }
 // Counts roll toward each new value; a rise briefly marks the number (data-bump).
 function Num(p){
  var target=Number(p.value)||0,start=Number.isFinite(p.from)?p.from:0,st=React.useState(function(){return reducedMotion()?target:start;}),shown=st[0],setShown=st[1];
  var from=React.useRef(shown),frame=React.useRef(0),mounted=React.useRef(false),node=React.useRef(null);
  React.useEffect(function(){
   var start=from.current,grew=mounted.current&&target>start;mounted.current=true;
   if(start===target)return;
   if(grew&&node.current){node.current.removeAttribute('data-bump');void node.current.offsetWidth;node.current.setAttribute('data-bump','');}
   if(reducedMotion()||typeof requestAnimationFrame!=='function'){from.current=target;setShown(target);return;}
   var began=0;
   function step(now){began=began||now;var k=Math.min(1,(now-began)/900),v=k<1?start+(target-start)*(1-Math.pow(1-k,3)):target;from.current=v;setShown(v);if(k<1)frame.current=requestAnimationFrame(step);}
   frame.current=requestAnimationFrame(step);
   return function(){cancelAnimationFrame(frame.current);};
  },[target]);
  return h('span',{ref:node,className:'pair-num'},target%1?shown.toFixed(1):String(Math.round(shown)));
 }
 // Segmented control with a thumb that slides to the selected tab; CSS keeps the plain selected style until measured.
 function Seg(p){
  var el=React.useRef(null);
  function place(){
   var node=el.current,thumb=node&&node.firstChild,on=node&&node.querySelector('.pair-tab.is-selected');
   if(!thumb)return;if(!on||!on.offsetWidth){node.removeAttribute('data-thumb');return;}
   thumb.style.width=on.offsetWidth+'px';thumb.style.height=on.offsetHeight+'px';thumb.style.transform='translate('+on.offsetLeft+'px,'+on.offsetTop+'px)';node.setAttribute('data-thumb','');
  }
  React.useLayoutEffect(function(){place();var node=el.current;if(node&&!node.hasAttribute('data-settled')&&typeof requestAnimationFrame==='function')requestAnimationFrame(function(){node.setAttribute('data-settled','');});},[p.selected]);
  React.useEffect(function(){if(typeof ResizeObserver!=='function'||!el.current)return;var ro=new ResizeObserver(place);ro.observe(el.current);return function(){ro.disconnect();};},[]);
  return h(p.as||'div',{ref:el,className:p.className,'aria-label':p.label},h('span',{className:'pair-seg-thumb','aria-hidden':'true'}),p.children);
 }
 // Slides the view body in from the side of the newly chosen tab without remounting it.
 function Swap(p){
  var el=React.useRef(null),first=React.useRef(true);
  React.useLayoutEffect(function(){
   if(first.current){first.current=false;return;}
   var node=el.current;if(!node||typeof node.animate!=='function'||reducedMotion())return;
   var run=node.animate([{opacity:0,transform:'translateX('+(p.dir<0?-18:18)+'px)'},{opacity:1,transform:'none'}],{duration:360,easing:'cubic-bezier(.2,.8,.2,1)'});
   return function(){run.cancel();};
  },[p.token]);
  return h('div',{ref:el,className:'pair-view'},p.children);
 }
 function Detail(p){
  var a=p.task,t=p.t,root=React.useRef(null);
  React.useEffect(function(){var el=root.current,host=el&&el.closest('.pair-panel-host');if(host&&host.clientWidth<700)el.scrollIntoView({block:'start',behavior:'auto'});},[a.id]);
  return h('section',{ref:root,className:'pair-detail','aria-label':t('detail')},
   h('div',{className:'pair-section-head'},h('span',{className:'pair-eyebrow'},a.id),h('button',{className:'pair-text-button',onClick:p.close},t('back'))),
   h('h2',null,a.subject),h(Chip,{tone:tone(a.stage)},t('stage.'+a.stage)),a.description&&h('p',{className:'pair-detail-copy'},a.description),
   h('div',{className:'pair-checks'},[[t('oracle'),a.oracle],[t('gate'),a.gate.current],...(p.parallel?[[t('integration'),a.integrated]]:[]),[t('done'),a.status==='completed']].map(function(x,n){return h('div',{key:x[0],className:x[1]?'is-done':'',style:{'--i':n}},h('i',null),h('span',null,x[0]),h('b',null,t(x[1]?'recorded':'pending')));})),
   h('h3',null,t('depends')),h('p',null,a.dependencies.join(', ')||t('noDeps')),
   h('h3',null,t('criteria')),a.criteria.length?h('ol',{className:'pair-criteria'},a.criteria.map(function(c,i){return h('li',{key:i,style:{'--i':Math.min(i,10)}},c);})):h('p',{className:'pair-muted'},t('unknown')),
   a.design.length>0&&h('div',null,h('h3',null,t('design')),a.design.map(function(d){return h('details',{key:d.useCase,className:'pair-contract'},h('summary',null,d.useCase),
    [[t('responsibility'),d.responsibility],[t('approach'),d.approach],[t('failure'),d.failure]].map(function(v){return v[1]&&h('p',{key:v[0]},h('strong',null,v[0]+' · '),v[1]);}),
    d.interactions.map(function(i,n){return h('p',{key:n},h('strong',null,t('contract')+' → '+i.target+' · '),i.contract);}));})),
   h('h3',null,t('cyclesHistory')),h('div',{className:'pair-cycle-list'},a.cycles.map(function(c){return h('div',{key:c.id},h('code',null,c.id),h(Chip,{tone:c.verdict==='reject'?'warn':c.verdict==='accept'?'good':'neutral'},c.verdict||c.step),c.repairs>0&&h('small',null,t('repairs')+' '+c.repairs));})));
 }

 return function Dashboard(p){
  var t=p.t,payload=p.data,team=payload&&payload.team,c=team&&team.counts,status=p.paused?'paused':p.status;
  // An old host projection omits the newer sections; saying so beats rendering them as "nothing was registered".
  var legacy=pairLegacyServer(team);
  var keptPercent=React.useRef(0),previousPercent=keptPercent.current;
  var progress=team&&team.progress;
  var percent=progress?pairSteadyPercent(progress,previousPercent):c&&c.total?Math.round(c.completed/c.total*100):previousPercent;
  keptPercent.current=percent;
  // Ongoing-activity loops only run for a live, visible, unpaused team that has not finished.
  var running=!!team&&status==='live'&&team.phase!=='DONE'&&team.phase!=='ABORTED',changed=p.changed||{};
  var rootClass='pair-runtime pair-density-'+p.density+(running?' is-running':'')+(p.entering?' is-entering':'');
  function btn(key,handler,on,disabled){return h('button',{key:key,type:'button',disabled:!!disabled,className:'pair-tab'+(on?' is-selected':''),'aria-pressed':!!on,onClick:handler},t(key));}
  var toolbar=h('header',{className:'pair-toolbar'},
   h('div',null,h('div',{className:'pair-eyebrow'},'PAIR / RUNTIME'),h('h1',null,t('title'))),
   h('div',{className:'pair-toolbar-actions'},h('span',{className:'pair-live is-'+status,role:'status'},h('i',null),t(status)),
    h('details',{className:'pair-display'},h('summary',null,t('display')),h('div',null,
     btn('comfortable',function(){p.setDensity('comfortable');},p.density==='comfortable'),
     btn('compact',function(){p.setDensity('compact');},p.density==='compact'),btn(p.paused?'resume':'pause',p.togglePause,false)))));
  if(!team)return h('div',{className:rootClass,'data-scheme':p.scheme==='dark'?'dark':'light'},toolbar,h('div',{className:'pair-empty'+(status==='loading'?' is-loading':'')},
   h('span',{className:'pair-empty-mark'},'P'),h('h2',null,status==='loading'?t('loading'):status==='error'?t('error'):t(payload&&payload.state==='unavailable'?'unavailable':'empty')),
   h('p',null,t(status==='error'?pairPanelErrorHint(p.error):payload&&payload.state==='unavailable'?'unavailableHint':'emptyHint')),status!=='loading'&&h('button',{className:'pair-button',onClick:p.refresh},t('retry'))));
  var taskList=h('section',{className:'pair-section pair-task-section'},
   h('div',{className:'pair-section-head'},h('h2',null,t('workflow')),h('span',{className:'pair-muted'},team.tasks.total+' '+t('rows'))),
   h('div',{className:'pair-task-controls'},
    h('input',{type:'search',disabled:p.paused,placeholder:t('search'),'aria-label':t('search'),value:p.query,onChange:function(e){p.search(e.target.value);}}),
    h(Seg,{className:'pair-segment',selected:p.filter},['all','active','blocked','completed'].map(function(key){var value=key==='completed'?'done':key;return btn(key,function(){p.filterBy(value);},p.filter===value,p.paused);}))),
   // Keying by stage remounts a row whose stage moved, so its highlight plays once.
   team.tasks.rows.length?h('div',{className:'pair-task-list'},team.tasks.rows.map(function(a,i){return h('button',{type:'button',disabled:p.paused,key:a.id+':'+a.stage,className:'pair-task-row pair-row-'+tone(a.stage)+(p.selected===a.id?' is-selected':'')+(changed[a.id]?' is-fresh':''),style:{'--i':Math.min(i,12)},onClick:function(){p.select(a.id);},'aria-label':a.id+' '+a.subject},
    h('span',{className:'pair-task-index'},a.id),h('span',{className:'pair-task-main'},h('strong',null,a.subject),h('small',null,(a.owner||t('unassigned'))+' · P'+a.priority+(a.waits.length?' · '+t('depends')+' '+a.waits.join(', '):''))),
    h(Chip,{tone:tone(a.stage)},t('stage.'+a.stage)));})):h('div',{className:'pair-inline-empty'},h('strong',null,t('noTasks')),h('p',null,t('noTasksHint'))),
   h('div',{className:'pair-pagination'},h('span',null,team.tasks.total?Math.min(team.tasks.offset+1,team.tasks.total)+'–'+Math.min(team.tasks.offset+team.tasks.rows.length,team.tasks.total)+' / '+team.tasks.total:'0 / 0'),
    h('button',{disabled:p.paused||team.tasks.offset===0,onClick:function(){p.page(Math.max(0,team.tasks.offset-24));}},t('previous')),
    h('button',{disabled:p.paused||team.tasks.offset+24>=team.tasks.total,onClick:function(){p.page(team.tasks.offset+24);}},t('next'))));
  // Stable keys (no list index) so only a newly recorded event mounts and animates in.
  var seen={};
  var history=h('section',{className:'pair-section'},h('div',{className:'pair-section-head'},h('h2',null,t('history')),h('span',{className:'pair-muted'},t('knownState'))),
   team.history.length?h('ol',{className:'pair-timeline'},team.history.map(function(e,i){var id=e.kind+'|'+e.ref+'|'+e.at;seen[id]=(seen[id]||0)+1;return h('li',{key:id+'|'+seen[id],className:'pair-event-'+e.kind,style:{'--i':Math.min(i,14)}},h(Stamp,{at:e.at}),h('i',null),h('div',null,h('strong',null,t('event.'+e.kind)),h('span',null,e.ref+' · '+e.text)));})):h('p',{className:'pair-muted'},t('noHistory')));
  return h('div',{className:rootClass,'data-scheme':p.scheme==='dark'?'dark':'light'},toolbar,
   (p.status==='stale'||p.status==='error')&&h('div',{className:'pair-alert',role:'alert'},t('stale'),h('button',{onClick:p.refresh},t('retry'))),
   payload.warnings.length>0&&h('div',{className:'pair-alert'},t('warning')),
   legacy&&h('div',{className:'pair-alert',role:'status'},t('legacy'),' ',h('span',{className:'pair-muted'},t('legacyHint'))),
   h('div',{className:'pair-run-heading'},h('div',null,h(Chip,{tone:team.phase==='DONE'?'good':team.phase==='ABORTED'?'warn':'active',busy:running},t('phase.'+team.phase)),h('span',{className:'pair-muted'},team.parallel?t('dual'):t('single'))),
    payload.teams.length>1?h('select',{'aria-label':t('knownState'),disabled:p.paused,value:team.id,onChange:function(e){p.chooseTeam(e.target.value);}},payload.teams.map(function(x){return h('option',{key:x.id,value:x.id},x.name);})):h('span',{className:'pair-run-name'},team.name)),
   h('section',{className:'pair-hero'},h('div',{className:'pair-progress-disc'+(percent>0&&percent<100?' is-partial':''),style:{'--pair-p':percent},title:t('milestoneProgress')+' · '+t('milestoneHint')},h('div',null,h('strong',null,h(Num,{value:percent,from:previousPercent}),h('small',null,'%')))),
    h('div',{className:'pair-hero-copy'},h('div',{className:'pair-eyebrow'},t('goal')),h('h2',null,team.goal),h('div',{className:'pair-hero-stats'},h('p',null,h('strong',null,h(Num,{value:c.completed}),' / '+c.total),' '+t('total')),progress&&progress.active&&h(ActiveTime,{active:progress.active,running:running,t:t}),progress&&h(Eta,{key:'eta-'+progress.eta.at,eta:progress.eta,gapMs:progress.active?progress.active.gapMs:null,running:running,t:t})))),
   progress&&h('section',{className:'pair-section pair-progress-detail'},
    h('div',{className:'pair-section-head'},h('h2',null,t('milestones')),h('span',{className:'pair-muted'},progress.acceptedIncrements+' '+t('acceptedIncrements'))),
    h('div',{className:'pair-milestones'},progress.milestones.map(function(value,i){return h('div',{key:i,className:progress.scored&&value>=progress.scored?'is-done':undefined},h('span',null,t('milestone.'+i)),h('b',null,h(Num,{value:value}),' / '+progress.scored),h(Bar,{label:t('milestone.'+i),value:value,total:progress.scored}));})),
    // The same number the disc uses. Saying it out loud is what stops "0%" from reading as failure.
    progress.terminated>0&&h('p',{className:'pair-muted pair-terminated'},t('terminated.pre')+progress.terminated+t('terminated.post'))),
   h('div',{className:'pair-metrics'},[[t('acceptance'),c.covered,c.criteria],[t('gate'),c.gateCurrent,c.total],[t('integration'),team.parallel?c.integrated:null,c.total]].map(function(m){var link=m[0]===t('acceptance')&&team.features&&team.features.length>0;return h('div',Object.assign({key:m[0]},link?{className:'is-link',role:'button',tabIndex:0,title:t('features.open'),onClick:function(){p.setView('features');},onKeyDown:function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();p.setView('features');}}}:{}),h('span',{title:m[0]===t('gate')?t('gateHint'):undefined},m[0]),h('strong',null,m[1]===null?'—':h(Num,{value:m[1]}),h('small',null,m[1]===null?'':' / '+m[2])),m[1]!==null&&h(Bar,{label:m[0],value:m[1],total:m[2]}));})),
   h(Seg,{as:'nav',className:'pair-view-tabs',label:t('tab'),selected:p.view},['overview','tasks','features','activity','value'].map(function(key){return btn(key,function(){p.setView(key);},p.view===key);})),
   h(Swap,{token:p.view,dir:p.viewDir},
    p.view==='overview'&&h('div',{className:'pair-overview'},
     h('section',{className:'pair-section pair-attention'},h('div',{className:'pair-section-head'},h('div',null,h('h2',null,t('current')),h('p',{className:'pair-section-sub'},t('current.hint'))),h(Chip,{tone:'neutral'},h(Num,{value:team.attention.total}))),
      // The same seat doing the same kind of work reads as one to-do; protocol wording stays under technical details.
      team.attention.items.length?pairAttentionGroups(team.attention.items).map(function(g){return h('div',{key:g.key,className:'pair-obligation'+(g.kind==='truncated-seat'?' is-warn':'')},
       h('div',{className:'pair-obligation-head'},h('span',{className:'pair-who'},g.who==='captain'?t('who.captain'):g.who),h('p',null,explain(t,g)),g.refs.length>1&&h('b',{className:'pair-obligation-count'},'×'+g.refs.length)),
       g.refs.length>0&&h('div',{className:'pair-refs'},g.refs.slice(0,6).map(function(r,n){return h('code',{key:n},r);}),g.refs.length>6&&h('small',null,'+'+(g.refs.length-6))),
       h('details',{className:'pair-evidence'},h('summary',null,t('evidence')),g.why.slice(0,3).map(function(w,n){return h('p',{key:n},w);}),g.tool&&h('code',null,g.tool)));}):h('div',{className:'pair-inline-empty'},h('strong',null,t('clear')),h('p',null,t('clearHint')))),
     h('section',{className:'pair-section'},h('div',{className:'pair-section-head'},h('h2',null,t('team')),h('span',{className:'pair-muted'},team.members.length)),
      h('div',{className:'pair-member-list'},team.members.map(function(m){var working=m.status==='working'&&!m.parked;return h('div',{key:m.name,className:'pair-member'+(working?' is-working':'')},h('span',{className:'pair-avatar is-'+String(m.role).toLowerCase().replace(/[^a-z-]/g,'')},m.role.slice(0,1).toUpperCase()),h('div',{className:'pair-member-main'},h('div',{className:'pair-member-name'},h('strong',null,m.name),h('small',null,m.taskIds.join(', ')||m.role)),
       h('div',{className:'pair-member-meta'},m.model?h('span',{className:'pair-model',title:(m.provider?m.provider+' / ':'')+m.model},m.model):h('span',{className:'pair-model is-unknown'},t('model.unknown')),
        m.model&&h('span',{className:'pair-effort'},t('effort')+' · '+(m.effort?(t('effort.'+m.effort)!=='effort.'+m.effort?t('effort.'+m.effort):m.effort):t('effort.default'))),
        h(WorkTime,{member:m,lease:team.workingLeaseMs,t:t}))),h(Chip,{tone:m.status==='working'?'active':m.parked?'warn':'neutral',busy:working},t('member.'+(m.parked?'parked':m.status))));})),
      h('details',{className:'pair-contract pair-seat-history'},h('summary',null,t('seatHistory')),
       h('p',{className:'pair-muted'},t('seatHistoryHint')),
       team.members.map(function(m){return h('div',{key:m.name},h('strong',null,m.name+' \u00b7 '+(m.replacements==null?t('unknown'):m.replacements)),
        (m.seatHistory||[]).length>0&&h('ol',{className:'pair-timeline'},(m.seatHistory||[]).map(function(e,i){return h('li',{key:i},h(Stamp,{at:e.at}),h('i',null),h('span',null,t('replacement.'+e.reason)));})));})),
      h('div',{className:'pair-pm-summary'},h('strong',null,t('pm')),h('span',null,team.product.untriaged+' '+t('awaiting')+' / '+team.product.deferred+' '+t('deferred'))),
      team.product.items.map(function(d){return h('details',{className:'pair-contract',key:d.id},h('summary',null,d.observation),h('p',null,d.value));}),
      team.mailboxes&&h('div',{className:'pair-mailboxes'},h('h3',null,t('mailbox')),h('div',null,team.mailboxes.map(function(m){return h('span',{key:m.name},m.name+' ',h('b',null,m.pending===null?'—':m.pending));})),h('small',null,t('mailboxHint'))))),
    p.view==='overview'&&h('details',{className:'pair-risk-summary'},h('summary',null,t('risks')+' · '+team.riskTotal),
     team.risks.length?team.risks.map(function(r){return h('div',{key:r.id},h(Chip,{tone:r.severity==='P2'?'neutral':'warn'},r.severity),h('span',null,r.id+' · '+r.text));}):h('p',null,t('noRisks'))),
    (p.view==='overview'||p.view==='tasks')&&h('div',{className:'pair-work-area'+(team.selected?' has-detail':'')},taskList,team.selected&&h(Detail,{key:team.selected.id,task:team.selected,parallel:team.parallel,t:t,close:function(){p.select(null);}})),
    p.view==='features'&&h(Features,{features:team.features,parallel:team.parallel,legacy:legacy,paused:p.paused,t:t,openTask:function(id){p.select(id);p.setView('tasks');}}),
    p.view==='activity'&&h('div',{className:'pair-activity'},h(Rhythm,{events:team.history,paceMs:progress?progress.eta.paceMs:null,undated:team.value?team.value.undatedPushbacks:0,t:t}),h('div',{className:'pair-activity-log'},history)),
    p.view==='value'&&h(Value,{value:team.value,legacy:legacy,t:t})),
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
  var ts=React.useState(''),teamId=ts[0],setTeam=ts[1],vs=React.useState('overview'),view=vs[0],setView=vs[1],viewDir=React.useRef(1);
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
  // Rows whose stage moved since the previous board get a one-time highlight.
  var tasks=displayData&&displayData.team?displayData.team.tasks:null,stages=React.useRef(null);
  var changed=React.useMemo(function(){var prev=stages.current,next={},out={};(tasks?tasks.rows:[]).forEach(function(r){next[r.id]=r.stage;if(prev&&prev[r.id]&&prev[r.id]!==r.stage)out[r.id]=true;});stages.current=Object.assign({},prev,next);return out;},[tasks]);
  // Staggered entrance plays when a team first appears (and again after switching teams).
  var hasTeam=!!(displayData&&displayData.team),es=React.useState(true),entering=es[0],setEntering=es[1];
  React.useEffect(function(){if(!hasTeam||!entering)return;var id=setTimeout(function(){setEntering(false);},1500);return function(){clearTimeout(id);};},[hasTeam,entering]);
  // Host themes swap token values, not a known attribute, so read the resolved text colour: light ink means a dark surface.
  var sc=React.useState('light'),scheme=sc[0],setScheme=sc[1];
  React.useEffect(function(){
   var host=root.current;if(!host||typeof getComputedStyle!=='function'||typeof document==='undefined')return;
   function read(){var node=host.querySelector('.pair-runtime'),rgb=node&&getComputedStyle(node).color.match(/[\d.]+/g);if(!rgb)return;setScheme((0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2])/255>0.5?'dark':'light');}
   read();
   var observer=typeof MutationObserver==='function'?new MutationObserver(read):null,media=typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null;
   if(observer)[document.documentElement,document.body].forEach(function(n){if(n)observer.observe(n,{attributes:true,attributeFilter:['class','style','data-theme','data-color-mode']});});
   if(media&&media.addEventListener)media.addEventListener('change',read);
   return function(){if(observer)observer.disconnect();if(media&&media.removeEventListener)media.removeEventListener('change',read);};
  },[]);
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
   data:displayData,error:snapshot.error,status:props.sessionId?snapshot.status:'paused',t:t,view:view,viewDir:viewDir.current,changed:changed,entering:entering,scheme:scheme,setView:function(next){var order=['overview','tasks','features','activity','value'];viewDir.current=order.indexOf(next)<order.indexOf(view)?-1:1;setView(next);},density:density,setDensity:setDensity,paused:paused||!visible,
   togglePause:function(){setPaused(function(x){return !x;});},refresh:source.refresh,query:query,filter:filter,selected:selected,
   search:function(v){setQuery(v.slice(0,160));setOffset(0);},filterBy:function(v){setFilter(v);setOffset(0);},page:setOffset,select:setSelected,
   chooseTeam:function(id){lastData.current=null;setEntering(true);setTeam(id);setSelected(null);setOffset(0);setQuery('');}
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
