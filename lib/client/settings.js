/**
 * Browser-side client module: the pair-programming top-level Settings
 * section (`settings.section` id 'pair-programming') for the `pair-programming`
 * namespace.
 *
 * Loaded by the web shell as a classic script through
 * `window.__ModuleLoader__.load` (no ESM syntax; scripts/build-client.mjs combines this source
 * with the runtime panel into the shipped lib/client.js asset). It binds the same
 * namespace the host plugin registers via dsh-settings (lib/settings.js) and
 * renders one staged-edit form: enums as selects, budgets as number inputs,
 * the green-build rule as a checkbox, the DoD list as text.
 *
 * Revision fencing, write queueing and latest-write recovery live inside the
 * settingsScope; the card only stages drafts and settles them with set/unset,
 * marking fields that came from the user layer with an "overridden" badge and
 * a reset-to-composed button. Without a served namespace the card stays
 * silent (status !== 'ready').
 *
 * @module dsh-pair-programming/client
 */
window.__ModuleLoader__.load({
  id: '@ericwang1358/dsh-pair-programming',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var storeMod = require('@deepseek-ai/dsh-client-store');
    var h = React.createElement;

    var SETTINGS_NS = 'pair-programming';          // must equal lib/settings.js SETTINGS_NAMESPACE
    var LOCALE_NS = 'settings.pair-programming';   // this card's locale copy namespace

    var TDD_MODES = ['enforce', 'coach', 'off'];
    var PAIR_STYLES = ['traditional', 'strong', 'ping-pong'];
    var TEAM_MODES = ['solo', 'light', 'full'];
    // Mirrors of lib/defaults.js. This file is served verbatim to the browser as
    // a classic script, so it cannot import them; tests/settings.test.mjs pins
    // these lists against the source of truth so a divergence fails the suite.
    var MEMBER_LIFETIMES = ['cycle', 'session'];
    var CE_LANES = ['off', 'captain', 'advisory', 'full'];
    var CE_SOLO_LANES = ['off', 'gesture', 'curated', 'full'];
    var CE_STATUS_NS = 'pair-programming-ce';       // must equal lib/integrations/ce-install.js

    var EN = {
      nav: 'Pair programming',
      cardTitle: 'Pair programming',
      cardDescription: 'The agile pair-programming protocol: Driver / Navigator / Challenger, Test-First cycles and the quality gate.',
      tddMode: 'TDD enforcement', tddModeHint: 'enforce: RED before GREEN is tool-mandated · coach: recommended · off: legacy report cycle.',
      pairStyle: 'Pairing style', pairStyleHint: 'traditional · strong (idea holder dictates) · ping-pong (author / implementer alternate).',
      defaultMode: 'Default team mode', defaultModeHint: 'solo (default): one short-lived SPEC seat writes the acceptance oracle with no repository tools, then you build against it. light/full keep the legacy durable Driver/Navigator(/Challenger) seats.',
      oracleFirst: 'Oracle first', oracleFirstHint: 'A task freezes its acceptance oracle before the Driver implements; pair_propose refuses without one.',
      oracleForkBudget: 'Oracle fork budget', oracleForkBudgetHint: 'Freezes of one task oracle before a captain override is required (default 3). A soft cap that surfaces re-fork loops; the override is one line and always available.',
      memberLifetime: 'Member seat lifetime', memberLifetimeHint: 'cycle respawns each seat from the board digest per Pair Cycle; session keeps one durable seat per role.',
      navigatorModel: 'Navigator model', navigatorModelHint: 'Model for the acceptance-definition seat (the navigator in pair modes, the SPEC seat in solo) — the oracle is the one artifact whose quality nothing downstream can machine-check. Options come from the host model catalog; empty = the captain route. Example: deepseek/deepseek-reasoner.',
      navigatorEffort: 'Navigator reasoning effort', navigatorEffortHint: 'Empty = the captain route\'s effort; "default" = the chosen model\'s adapter default; the other options are the efforts that model publishes. An effort without a model override is legal: same model, steeper thinking.',
      navTest: 'Test route', navTesting: 'Testing…',
      navigatorModelProbeToken: 'Last route test', navigatorModelProbeTokenHint: 'Written by the Test route button. The browser cannot reach the adapters, so the button only asks the host to resolve the route; the verdict shows above.',
      navNeverTested: 'Not tested yet — save first, then press Test route; the host resolves the route and reports back.',
      maxCyclesPerTask: 'Max cycles per task', maxCyclesPerTaskHint: 'Hard budget — after it the captain must consult you. Blank uses the composed value.',
      maxOpenRisks: 'Max open risks', maxOpenRisksHint: 'Team-wide cap on OPEN non-P0 risk tickets; a P0 bypasses it. Blank uses the composed value.',
      planningMaxArbitrations: 'Planning arbitrations per task', planningMaxArbitrationsHint: 'Cap on disputes resolved while a task is still being planned; 0 is refused. Blank uses the composed value.',
      spikeMaxCycles: 'Spike max cycles', spikeMaxCyclesHint: 'A spike exits with a decision, not code.',
      greenBuildOnStop: 'Green build on stop', greenBuildOnStopHint: 'Nobody goes home on a red build: pair_stop demands fresh whole-suite evidence.',
      dod: 'Definition of Done', dodHint: 'Comma-separated item ids, e.g. all_accepted,verify_evidence,test_first. Blank = protocol defaults.',
      dodCommand: 'DoD command', dodCommandHint: 'Optional command the gate runs itself, e.g. "node tests/run.mjs". Blank = evidence stays honor-system.',
      experimentalDualDrivers: 'Enable isolated dual Drivers', experimentalDualDriversHint: 'When the integration command below is saved, new teams start in light mode with two isolated Driver worktrees. Active teams never change.',
      dualDriverIntegrationCommand: 'Integration command', dualDriverIntegrationCommandHint: 'A runnable whole-suite command after every candidate merge, e.g. "npm test". Leave blank to keep this experiment inactive.',
      dualDriversReady: 'Ready — new teams will use two isolated Drivers and verify every candidate merge.',
      dualDriversNeedsCommand: 'Add a runnable integration command to activate this experiment. Until then, new teams keep their normal single-Driver start.',
      dualDriversOff: 'Off — new teams keep their normal single-Driver start.',
      secDualDrivers: 'Experimental: isolated dual Drivers', secDualDriversSummary: 'two worktrees, serialized verified integration',
      ceSection: 'Compound Engineering',
      ceLanes: 'CE lane', ceLanesHint: 'off (default): the skill provider is never registered and costs zero tokens · captain: user-gesture skills only, still zero model-facing tokens · advisory: adds the analytical skills to the model catalog · full: also allows the phase-bound persona push.',
      ceSoloLane: 'CE lane without a team', ceSoloLaneHint: 'What a session with NO live pair team sees. off · gesture: every skill, human /name only, zero repeated tokens · curated: the pair allowlist · full: every skill in the model catalog (the convenient setting, and the one billed on every step). The lane narrows automatically the moment a team goes live.',
      cePath: 'CE path', cePathHint: 'Path to a local Compound Engineering checkout. Blank auto-detects ~/.dsh/packages and the Claude Code plugin registry. Detection is read-only: this plugin never downloads or installs CE.',
      ceProbeToken: 'Last probe request', ceProbeTokenHint: 'Written by the Detect button. The browser cannot read a filesystem, so the button asks the host to probe and the result appears below.',
      ceDetect: 'Detect', ceDetecting: 'Detecting…', ceStatusLabel: 'Detection',
      ceNever: 'No probe has run in this deployment yet.',
      ceCost: 'Model catalog cost', ceCostFree: 'nothing enters the model catalog — zero repeated tokens',
      ceReview: 'This checkout differs from the reviewed CE release — the allowlist needs a human pass before the lane is trusted.',
      secProtocol: 'Protocol', secProtocolSummary: 'roles, TDD, oracle-first',
      secModel: 'Acceptance model', secModelSummary: 'the seat that defines acceptance',
      secBudgets: 'Budgets', secBudgetsSummary: 'cycles, risks, arbitrations',
      secGate: 'Completion gate', secGateSummary: 'Definition of Done, green build',
      secCe: 'Compound Engineering', secCeSummary: 'lanes, detection, catalog cost',
      secDiag: 'Diagnostics', secDiagSummary: 'last probe requests',
      diagNever: '(never requested)',
      diagHint: 'Written by the Detect and Test buttons above. Read-only: typing a token here would fire a probe with no verdict behind it.',
      invalidCommand: 'This is executed verbatim — give one runnable command line, not a description of one.',
      overridden: 'Overridden', reset: 'reset', baseLabel: 'composed',
      save: 'Save', saving: 'Saving…', discard: 'Discard', unsaved: 'Unsaved changes',
      saveFailed: 'The deployment did not accept these values — your draft is kept.',
      readOnly: 'Settings are read-only in this deployment.',
      invalidNumber: 'Enter an integer ≥ 1, or leave blank for the composed value.',
      invalidDod: 'Unknown DoD item; valid ids: all_accepted, no_blocking_risks, verify_evidence, decisions_documented, test_first, spike_outcome.',
    };
    var ZH = {
      nav: '结对编程',
      cardTitle: '结对编程',
      cardDescription: '敏捷结对协议：Driver / Navigator / Challenger、测试先行循环与质量门禁。',
      tddMode: 'TDD 强制程度', tddModeHint: 'enforce：先 RED 后 GREEN 由工具强制 · coach：推荐不强制 · off：旧式报告循环。',
      pairStyle: '结对风格', pairStyleHint: 'traditional · strong（想法持有者口述）· ping-pong（测试作者与实现者交替）。',
      defaultMode: '默认团队模式', defaultModeHint: 'solo（默认）：一个短命 SPEC 席位在无任何仓库工具的情况下写下验收 oracle，随后退休，由你自己实现。light/full 保留 v3 的常驻 Driver/Navigator（/Challenger）席位。',
      oracleFirst: 'Oracle 先行', oracleFirstHint: '任务在 Driver 动手前先冻结验收 oracle；未冻结时 pair_propose 拒绝开循环。',
      oracleForkBudget: 'Oracle 冻结预算', oracleForkBudgetHint: '一个任务的 oracle 允许的冻结次数上限（默认 3），超出需队长一句话覆盖。软上限，用来把重复冻结的循环可见化，不阻断真实进展。',
      memberLifetime: '成员席位生命周期', memberLifetimeHint: 'cycle 每个结对循环由看板摘要重派席位；session 保留每角色一个常驻席位。',
      navigatorModel: '导航员模型', navigatorModelHint: '验收定义席位（结对模式为 navigator，solo 为 SPEC 席位）的模型——oracle 是唯一下游无法机判质量的工件。选项来自宿主模型目录；留空 = 跟随队长。例：deepseek/deepseek-reasoner。',
      navigatorEffort: '导航员推理程度', navigatorEffortHint: '留空 = 继承队长路由的推理强度；default = 所选模型的适配器默认档；其余选项为该模型公布的档位。只设 effort 不设模型也合法：同模型、更深思考。',
      navTest: '测试路由', navTesting: '测试中…',
      navigatorModelProbeToken: '最近路由测试', navigatorModelProbeTokenHint: '由「测试路由」按钮写入。浏览器读不到适配器，因此按钮只是请求宿主解析路由，结果显示在上方。',
      navNeverTested: '尚未测试——先保存，再点「测试路由」；宿主会解析该路由并回显结果。',
      navFallbackMark: '已回退为队长模型与配置：',
      navFallbackHow: '如需使用贵模型：补充用量后重新选择模型，点「测试路由」验证通过，下一次席位回收/重生即恢复。',
      maxCyclesPerTask: '单任务最大循环数', maxCyclesPerTaskHint: '硬预算，超限队长必须向用户请示。留空使用组合基线值。',
      maxOpenRisks: '风险票开放上限', maxOpenRisksHint: '全队 OPEN 非 P0 风险票上限；P0 不受此限。留空使用组合基线值。',
      planningMaxArbitrations: '单任务规划仲裁上限', planningMaxArbitrationsHint: '任务进入开发前可裁决的争议数上限；0 被拒。留空使用组合基线值。',
      spikeMaxCycles: 'Spike 循环上限', spikeMaxCyclesHint: 'Spike 以决策收尾，不产代码。',
      greenBuildOnStop: '停止时要求绿灯构建', greenBuildOnStopHint: '没有人带着红构建回家：pair_stop 需新鲜全量测试证据。',
      dod: '完成标准（DoD）', dodHint: '逗号分隔条目 id，如 all_accepted,verify_evidence,test_first。留空 = 协议默认。',
      dodCommand: '完成标准命令', dodCommandHint: '可选：由 gate 亲自执行的命令，如 "node tests/run.mjs"。留空 = 证据仍靠荣誉制。',
      experimentalDualDrivers: '启用隔离双 Driver', experimentalDualDriversHint: '保存下方合并验证命令后，新团队会以 light 模式启动两个隔离 Driver 工作树；运行中的团队不会改变。',
      dualDriverIntegrationCommand: '合并验证命令', dualDriverIntegrationCommandHint: '每次候选合并后运行的全量验证命令，例如 “npm test”。留空则本实验不会生效。',
      dualDriversReady: '已就绪——新团队会使用两个隔离 Driver，并验证每次候选合并。',
      dualDriversNeedsCommand: '请补充可运行的合并验证命令以启用实验；此前新团队仍按普通单 Driver 启动。',
      dualDriversOff: '已关闭——新团队仍按普通单 Driver 启动。',
      secDualDrivers: '实验性：隔离双 Driver', secDualDriversSummary: '双工作树、串行集成验证',
      ceSection: 'Compound Engineering 接入',
      ceLanes: 'CE 车道', ceLanesHint: 'off（默认）：不注册 skill provider，零 token 开销 · captain：仅用户手势技能，模型侧仍为零开销 · advisory：把分析类技能加入模型目录 · full：额外允许按阶段的 persona 注入。',
      ceSoloLane: '无团队时的 CE 车道', ceSoloLaneHint: '没有活跃 pair team 的会话看到什么。off · gesture：全部技能仅限人工 /name 触发，零重复 token · curated：与 pair 相同的精选集 · full：全部技能进模型目录（最方便，也是每步都要付费的那个）。一旦有团队开起来，车道会自动收窄。',
      cePath: 'CE 路径', cePathHint: '本地 Compound Engineering 检出目录。留空则自动探测 ~/.dsh/packages 与 Claude Code 插件注册表。探测只读：本插件从不下载或安装 CE。',
      ceProbeToken: '最近一次探测请求', ceProbeTokenHint: '由「检测」按钮写入。浏览器读不到文件系统，因此按钮只是请求宿主探测，结果显示在下方。',
      ceDetect: '检测', ceDetecting: '检测中…', ceStatusLabel: '探测结果',
      ceNever: '本部署尚未执行过探测。',
      ceCost: '模型目录开销', ceCostFree: '不进入模型目录——零重复 token',
      ceReview: '该检出与已评审的 CE 版本不一致——白名单需要人工过一遍后才可信任该车道。',
      secProtocol: '协议', secProtocolSummary: '角色、TDD、验收先行',
      secModel: '验收模型', secModelSummary: '定义验收标准的席位',
      secBudgets: '预算', secBudgetsSummary: '循环、风险、仲裁',
      secGate: '完成门禁', secGateSummary: '完成标准、绿构建',
      secCe: 'Compound Engineering', secCeSummary: '车道、探测、目录开销',
      secDiag: '诊断', secDiagSummary: '最近一次探测请求',
      diagNever: '（从未请求）',
      diagHint: '由上方「检测」与「测试路由」按钮写入。只读：手动填入 token 会触发一次没有结论的探测。',
      invalidCommand: '此项会被逐字执行——请给一条可运行的命令行，而不是对它的描述。',
      overridden: '已覆盖', reset: '恢复', baseLabel: '组合基线',
      save: '保存', saving: '保存中…', discard: '放弃', unsaved: '有未保存的修改',
      saveFailed: '部署未接受这些值——草稿已保留。',
      readOnly: '本部署中设置为只读。',
      invalidNumber: '请输入 ≥1 的整数；留空用组合基线值。',
      invalidDod: '存在未知 DoD 项；合法 id：all_accepted、no_blocking_risks、verify_evidence、decisions_documented、test_first、spike_outcome',
    };

    /* ---- field specs: text <-> value ---------------------- */
    var DOD_ITEMS = ['all_accepted', 'no_blocking_risks', 'verify_evidence', 'decisions_documented', 'test_first', 'spike_outcome'];
    function numberField(name) {
      return { field: name, invalidKind: 'number',
        format: function (v) { return typeof v === 'number' ? String(v) : ''; },
        parse: function (text) {
          var t = text.trim();
          if (t === '') return { kind: 'clear' };
          var v = Number(t);
          return Number.isInteger(v) && v >= 1 ? { kind: 'set', value: v } : undefined;
        } };
    }
    function enumField(name, allowed) {
      return { field: name, invalidKind: 'enum',
        format: function (v) { return typeof v === 'string' && allowed.indexOf(v) !== -1 ? v : allowed[0]; },
        parse: function (text) {
          return allowed.indexOf(text) !== -1 ? { kind: 'set', value: text } : undefined;
        } };
    }
    function boolField(name) {
      return { field: name, invalidKind: 'none',
        format: function (v) { return v === true ? '1' : v === false ? '0' : ''; },
        parse: function (text) {
          return text === '1' ? { kind: 'set', value: true }
            : text === '0' ? { kind: 'set', value: false }
            : { kind: 'clear' };
        } };
    }
    function dodField(name) {
      return { field: name, invalidKind: 'dod',
        format: function (v) { return typeof v === 'string' ? v : ''; },
        parse: function (text) {
          var t = text.trim();
          if (t === '') return { kind: 'clear' };
          var items = t.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          if (items.length === 0 || items.some(function (i) { return DOD_ITEMS.indexOf(i) === -1; })) return undefined;
          return { kind: 'set', value: items.join(',') };
        } };
    }

    function textField(name) {
      return { field: name, invalidKind: 'none',
        format: function (v) { return typeof v === 'string' ? v : ''; },
        parse: function (text) {
          var t = text.trim();
          return t === '' ? { kind: 'clear' } : { kind: 'set', value: t };
        } };
    }
    /* ---- CardForm: staged drafts over a settingsScope ---------------------- */
    function CardForm(scope, specs) {
      var self = { scope: scope, specs: specs, staged: new Map(), listeners: new Set(), saving: false, failed: false, testing: false };
      scope.subscribe(function () { publish(); });
      function publish() { self.listeners.forEach(function (l) { l(); }); }
      function snap() { return scope.getSnapshot(); }
      function specOf(name) { for (var i = 0; i < self.specs.length; i += 1) if (self.specs[i].field === name) return self.specs[i]; }
      function effective(name) { return (snap().value || {})[name]; }
      function baseValue(name) { var b = snap().base; return b && b[name]; }
      function stored(name) { var u = snap().user; return u !== undefined && Object.prototype.hasOwnProperty.call(u, name); }

      self.shell = function () {
        var plan = self.plan();
        return {
          available: snap().status === 'ready',
          writable: snap().writable === true,
          dirty: self.staged.size > 0,
          invalid: plan.some(function (i) { return i.run === undefined; }),
          saving: self.saving, failed: self.failed, probing: self.probing === true,
          open: Object.assign({}, self.open), testing: self.testing === true,
        };
      };
      self.field = function (name) {
        var spec = specOf(name);
        var draft = self.staged.get(name);
        if (draft === undefined) {
          return { text: spec.format(effective(name)), overridden: stored(name), invalid: false, baseText: spec.format(baseValue(name)) };
        }
        var w = spec.parse(draft);
        return { text: draft, overridden: w !== undefined && w.kind === 'set', invalid: w === undefined, invalidKind: spec.invalidKind, baseText: spec.format(baseValue(name)) };
      };
      self.plan = function () {
        var out = [];
        self.staged.forEach(function (text, name) {
          var spec = specOf(name);
          var w = spec.parse(text);
          out.push({ name: name, run: w === undefined ? undefined : (w.kind === 'clear'
            ? function () { return self.scope.unset(name).then(function () { return !stored(name); }); }
            : function () { return self.scope.set(name, w.value).then(function () { return (snap().user || {})[name] === w.value; }); }) });
        });
        return out;
      };
      self.save = function () {
        var plan = self.plan();
        var writes = plan.filter(function (i) { return i.run !== undefined; });
        if (plan.length === 0 || self.saving || writes.length !== plan.length) return;
        self.saving = true; self.failed = false; publish();
        Promise.all(writes.map(function (i) { return i.run(); })).then(function (landed) {
          var ok = landed.every(Boolean);
          if (ok) self.staged.clear();
          self.saving = false; self.failed = !ok; publish();
        }, function () { self.saving = false; self.failed = true; publish(); });
      };
      self.discard = function () { self.staged.clear(); self.failed = false; publish(); };
      // Section collapse. The card serves twenty fields; rendering all of them
      // open turned the Plugins tab into a wall the user has to scroll past to
      // reach anything else. Only the first group is open by default, and a
      // group that holds a staged edit or a problem is forced open so a hidden
      // row can never be the reason a save is refused.
      self.open = { protocol: true, dualDrivers: false, budgets: false, gate: false, model: false, ce: false, diag: false };
      self.toggle = function (key) { self.open[key] = !self.open[key]; publish(); };
      // The Detect button is an ACTION, not a draft: it asks the host to probe
      // now. Staging it would mean a user has to press Detect and then Save,
      // and a token sitting unsaved in a form is not a request for anything.
      self.probe = function () {
        if (self.probing) return;
        self.probing = true; publish();
        Promise.resolve(self.scope.set('ceProbeToken', String(Date.now())))
          .then(function () { self.probing = false; publish(); },
                function () { self.probing = false; self.failed = true; publish(); });
      };
      // The route test follows the probe pattern: an ACTION that writes the
      // token, never a staged draft. It validates the COMMITTED values — the
      // hint says save first, same contract as the CE Detect button.
      self.testRoute = function () {
        if (self.testing) return;
        self.testing = true; publish();
        Promise.resolve(self.scope.set('navigatorModelProbeToken', String(Date.now())))
          .then(function () { self.testing = false; publish(); },
                function () { self.testing = false; self.failed = true; publish(); });
      };
      self.actions = function () {
        return {
          edit: function (name, text) { self.staged.set(name, text); self.failed = false; publish(); },
          resetField: function (name) {
            var spec = specOf(name);
            // staging the composed text means "set back to base"; when the base
            // layer has no value, empty text parses to clear (unset) — both are
            // the reset semantics, no special-casing needed.
            self.staged.set(name, spec.format(baseValue(name)));
            publish();
          },
          save: self.save, discard: self.discard, probe: self.probe,
          toggle: function (key) { self.toggle(key); }, testRoute: self.testRoute,
        };
      };
      self.snapshotFields = function () {
        var out = {};
        self.specs.forEach(function (spec) { out[spec.field] = self.field(spec.field); });
        return out;
      };
      self.bindStore = function (project) {
        var store = storeMod.createSnapshotStore(project());
        self.listeners.add(function () { store.set(project()); });
        return store;
      };
      return self;
    }

    /* ---- controls (hand-written React primitives, same props contract) ---- */
    function Badge(p) {
      if (!p.overridden) return null;
      return h('span', { style: { fontSize: 12, marginLeft: 8, opacity: 0.9 } },
        h('em', null, p.overriddenLabel), ' ',
        h('button', { type: 'button', disabled: p.disabled, onClick: p.onReset, style: { cursor: 'pointer' } }, p.resetLabel),
        h('span', { title: p.baseText, style: { opacity: 0.6, marginLeft: 4 } }, '(' + p.baseLabel + ': ' + p.baseText + ')'));
    }
    function FieldRow(p) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' } },
        h('div', { style: { display: 'flex', alignItems: 'center' } }, h('strong', null, p.label), h(Badge, p)),
        p.children,
        h('p', { style: { margin: 0, fontSize: 12, opacity: 0.65 } }, p.invalid ? p.invalidCopy : p.hint),
      );
    }
    function SelectRow(p) {
      return h(FieldRow, p,
        h('select', { disabled: p.disabled, value: p.text, onChange: function (e) { p.onEdit(e.target.value); }, style: { alignSelf: 'flex-start', padding: '2px 6px' } },
          p.options.map(function (o) { return h('option', { key: o, value: o }, o); })));
    }
    function InputRow(p) {
      return h(FieldRow, p,
        h('input', { disabled: p.disabled, value: p.text, inputMode: p.numeric ? 'numeric' : undefined, type: 'text',
          onChange: function (e) { p.onEdit(e.target.value); }, style: { maxWidth: 320, padding: '3px 6px' } }));
    }
    function CheckRow(p) {
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' } },
        h('strong', null, p.label),
        h('input', { type: 'checkbox', disabled: p.disabled, checked: p.text === '1', onChange: function (e) { p.onEdit(e.target.checked ? '1' : '0'); } }),
        h(Badge, p),
        h('p', { style: { margin: 0, fontSize: 12, opacity: 0.65 } }, p.hint));
    }

    /** Host-written detection facts. Read-only here: the card never writes them. */
    function CeStatusBlock(p) {
      var st = p.status || {};
      var known = st.status === 'found' || st.status === 'not-found';
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('strong', null, p.statusLabel),
          h('button', { type: 'button', disabled: p.disabled || p.probing, onClick: p.onProbe, style: { cursor: 'pointer' } },
            p.probing ? p.detectingLabel : p.detectLabel)),
        h('p', { style: { margin: 0, fontSize: 12, opacity: 0.8 } }, known ? st.summary : p.neverLabel),
        st.reviewNeeded ? h('p', { style: { margin: 0, fontSize: 12, color: 'darkorange' } }, p.reviewLabel) : null,
        h('p', { style: { margin: 0, fontSize: 12, opacity: 0.7 } }, p.costLabel + ': ' + (st.catalogSkills > 0
          ? st.catalogSkills + ' × ~' + st.catalogTokens + ' tok/step'
          : p.costFree)),
        st.fingerprint ? h('p', { style: { margin: 0, fontSize: 11, opacity: 0.55 } }, 'fingerprint ' + st.fingerprint) : null);
    }

    /** The model-catalog dropdown options: '' (inherit) + provider/model ids. */
    function modelOptions(groups, current) {
      var out = [''];
      (groups || []).forEach(function (group) {
        (group.models || []).forEach(function (model) {
          out.push(group.id + '/' + model.id);
        });
      });
      if (current !== undefined && current !== '' && out.indexOf(current) === -1) out.push(current);
      return out;
    }
    /** Effort options for the chosen model: '' inherit, 'default', adapter ids. */
    function effortOptions(groups, currentModel, currentEffort) {
      var out = ['', 'default'];
      var slash = currentModel.indexOf('/');
      if (slash !== -1) {
        var provider = currentModel.slice(0, slash);
        var model = currentModel.slice(slash + 1);
        (groups || []).forEach(function (group) {
          if (group.id !== provider) return;
          (group.models || []).forEach(function (entry) {
            if (entry.id !== model || !entry.reasoning) return;
            (entry.reasoning.efforts || []).forEach(function (level) {
              out.push(level.id);
            });
          });
        });
      }
      if (currentEffort !== undefined && currentEffort !== '' && out.indexOf(currentEffort) === -1) out.push(currentEffort);
      return out;
    }
    /** The route-test verdict block: button + the host's resolve answer + the fallback marker. */
    function NavTestBlock(p) {
      var verdict;
      if (p.status === undefined) verdict = p.t('navNeverTested');
      else verdict = (p.status.ok ? '\u2713 ' : '\u2717 ') + (p.status.detail || p.t('navNeverTested'));
      var fallback = p.status && p.status.fallbackActive
        ? h('p', { style: { margin: 0, fontSize: 12, color: 'darkorange' } },
            '\u26a0 ' + p.t('navFallbackMark') + (p.status.fallbackDetail || '') + ' ' + p.t('navFallbackHow'))
        : null;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,.15)' } },
        fallback,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { type: 'button', disabled: p.disabled || p.testing, onClick: p.onTest, style: { cursor: 'pointer' } },
            p.testing ? p.t('navTesting') : p.t('navTest'))),
        h('p', { style: { margin: 0, fontSize: 12, color: p.status && !p.status.ok ? 'crimson' : undefined, opacity: p.status && p.status.ok ? 0.8 : undefined } }, verdict));
    }

    /**
     * One collapsible group.
     *
     * `force` opens it regardless of the user's toggle: a section holding a
     * staged edit or an invalid value must never be the hidden reason a save
     * button is disabled. Collapse is a reading aid, never a place a problem
     * can hide.
     */
    function Section(p) {
      var open = p.open || p.force;
      var shellStyle = p.experimental ? { margin: '14px 0 0', padding: '0 12px 10px', border: '1px solid rgba(112,90,220,.45)', borderRadius: 10, background: 'linear-gradient(135deg, rgba(112,90,220,.08), rgba(64,160,220,.06))' } : { margin: '12px 0 0' };
      return h('div', { style: shellStyle },
        h('button', {
          type: 'button', onClick: p.onToggle,
          style: {
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
            background: 'none', border: 'none', padding: '6px 0', cursor: 'pointer',
            fontSize: 13, fontWeight: 600, borderTop: p.experimental ? 'none' : '1px solid rgba(128,128,128,.2)',
          },
        },
        h('span', { style: { opacity: 0.6, fontSize: 11 } }, open ? '▾' : '▸'),
        h('span', null, p.title),
        p.dirty ? h('span', { style: { fontSize: 11, opacity: 0.7 } }, '•') : null,
        h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55, fontWeight: 400 } }, open ? '' : p.summary)),
        open ? h('div', null, p.children) : null);
    }

    /** A host-written value the user reads but must never type into. */
    function ReadOnlyRow(p) {
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0' } },
        h('span', { style: { fontSize: 12, opacity: 0.7 } }, p.label),
        h('code', { style: { fontSize: 11, opacity: 0.75 } }, p.value || p.emptyLabel));
    }

    function PairCard(props) {
      var t = props.t;
      var state = props.usePairCard(function (s) { return s; });
      if (!state.available) return null;
      var disabled = !state.writable;
      var groups = state.navGroups || [];
      var modelText = state.fields.navigatorModel.text;
      var modelControl = groups.length > 0
        ? h(SelectRow, Object.assign({ label: t('navigatorModel'), hint: t('navigatorModelHint'), options: modelOptions(groups, modelText) }, bind('navigatorModel'), { invalidCopy: t('invalidNumber') }))
        : h(InputRow, Object.assign({ label: t('navigatorModel'), hint: t('navigatorModelHint') }, bind('navigatorModel'), { invalidCopy: t('invalidNumber') }));
      var effortControl = groups.length > 0
        ? h(SelectRow, Object.assign({ label: t('navigatorEffort'), hint: t('navigatorEffortHint'), options: effortOptions(groups, modelText, state.fields.navigatorEffort.text) }, bind('navigatorEffort'), { invalidCopy: t('invalidNumber') }))
        : h(InputRow, Object.assign({ label: t('navigatorEffort'), hint: t('navigatorEffortHint') }, bind('navigatorEffort'), { invalidCopy: t('invalidNumber') }));
      var dualDriversEnabled = state.fields.experimentalDualDrivers.text === '1';
      var dualDriverCommand = state.fields.dualDriverIntegrationCommand.text.trim();
      var dualDriverReady = dualDriversEnabled && dualDriverCommand !== '';
      var dualDriverStatus = t(dualDriverReady ? 'dualDriversReady' : dualDriversEnabled ? 'dualDriversNeedsCommand' : 'dualDriversOff');
      function bind(name) {
        var f = state.fields[name];
        return Object.assign({}, f, {
          disabled: disabled,
          overriddenLabel: t('overridden'), resetLabel: t('reset'), baseLabel: t('baseLabel'),
          onEdit: function (v) { props.edit(name, v); },
          onReset: function () { props.resetField(name); },
        });
      }
      // A section is forced open when it holds an invalid value, so collapsing
      // can never hide the reason a save button is disabled.
      function group(names) {
        var bad = false;
        for (var i = 0; i < names.length; i += 1) {
          var f = state.fields[names[i]];
          if (f !== undefined && f.invalid) bad = true;
        }
        return { dirty: bad, force: bad };
      }
      function section(key, titleKey, summaryKey, names, children, experimental) {
        var g = group(names);
        return h(Section, {
          title: t(titleKey), summary: t(summaryKey),
          open: state.open[key], force: g.force, dirty: g.dirty,
          experimental: experimental === true,
          onToggle: function () { props.toggle(key); },
        }, children);
      }

      return h('li', { style: { listStyle: 'none', border: '1px solid rgba(128,128,128,.35)', borderRadius: 12, padding: '4px 16px 12px', margin: '0 0 16px' } },
        h('h3', { style: { margin: '8px 0 2px' } }, t('cardTitle')),
        h('p', { style: { margin: '0 0 6px', fontSize: 13, opacity: 0.7 } }, t('cardDescription')),
        disabled ? h('p', { style: { fontSize: 13 } }, t('readOnly')) : null,

        section('protocol', 'secProtocol', 'secProtocolSummary', ['tddMode', 'pairStyle', 'defaultMode', 'oracleFirst', 'memberLifetime'], [
          h(SelectRow, Object.assign({ key: 'tddMode', label: t('tddMode'), hint: t('tddModeHint'), options: TDD_MODES }, bind('tddMode'), { invalidCopy: t('invalidNumber') })),
          h(SelectRow, Object.assign({ key: 'pairStyle', label: t('pairStyle'), hint: t('pairStyleHint'), options: PAIR_STYLES }, bind('pairStyle'), { invalidCopy: t('invalidNumber') })),
          h(SelectRow, Object.assign({ key: 'defaultMode', label: t('defaultMode'), hint: t('defaultModeHint'), options: TEAM_MODES }, bind('defaultMode'), { invalidCopy: t('invalidNumber') })),
          h(CheckRow, Object.assign({ key: 'oracleFirst', label: t('oracleFirst'), hint: t('oracleFirstHint') }, bind('oracleFirst'))),
          h(SelectRow, Object.assign({ key: 'memberLifetime', label: t('memberLifetime'), hint: t('memberLifetimeHint'), options: MEMBER_LIFETIMES }, bind('memberLifetime'), { invalidCopy: t('invalidNumber') })),
        ]),

        section('dualDrivers', 'secDualDrivers', 'secDualDriversSummary', ['experimentalDualDrivers', 'dualDriverIntegrationCommand'], [
          h(CheckRow, Object.assign({ key: 'experimentalDualDrivers', label: t('experimentalDualDrivers'), hint: t('experimentalDualDriversHint') }, bind('experimentalDualDrivers'))),
          h(InputRow, Object.assign({ key: 'dualDriverIntegrationCommand', label: t('dualDriverIntegrationCommand'), hint: t('dualDriverIntegrationCommandHint') }, bind('dualDriverIntegrationCommand'), { invalidCopy: t('invalidCommand') })),
          h('p', { key: 'dualDriverStatus', style: { margin: '8px 0 0', fontSize: 12, color: dualDriverReady ? 'seagreen' : dualDriversEnabled ? 'darkorange' : undefined, opacity: dualDriversEnabled ? 1 : 0.7 } }, dualDriverStatus),
        ], true),

        section('model', 'secModel', 'secModelSummary', ['navigatorModel', 'navigatorEffort'], [
          modelControl,
          effortControl,
          h(NavTestBlock, { key: 'navtest', t: t, disabled: disabled, testing: state.testing, onTest: props.testRoute, status: state.navStatus }),
        ]),

        section('budgets', 'secBudgets', 'secBudgetsSummary', ['maxCyclesPerTask', 'oracleForkBudget', 'maxOpenRisks', 'planningMaxArbitrations', 'spikeMaxCycles'], [
          h(InputRow, Object.assign({ key: 'maxCyclesPerTask', label: t('maxCyclesPerTask'), hint: t('maxCyclesPerTaskHint'), numeric: true }, bind('maxCyclesPerTask'), { invalidCopy: t('invalidNumber') })),
          h(InputRow, Object.assign({ key: 'oracleForkBudget', label: t('oracleForkBudget'), hint: t('oracleForkBudgetHint'), numeric: true }, bind('oracleForkBudget'), { invalidCopy: t('invalidNumber') })),
          h(InputRow, Object.assign({ key: 'maxOpenRisks', label: t('maxOpenRisks'), hint: t('maxOpenRisksHint'), numeric: true }, bind('maxOpenRisks'), { invalidCopy: t('invalidNumber') })),
          h(InputRow, Object.assign({ key: 'planningMaxArbitrations', label: t('planningMaxArbitrations'), hint: t('planningMaxArbitrationsHint'), numeric: true }, bind('planningMaxArbitrations'), { invalidCopy: t('invalidNumber') })),
          h(InputRow, Object.assign({ key: 'spikeMaxCycles', label: t('spikeMaxCycles'), hint: t('spikeMaxCyclesHint'), numeric: true }, bind('spikeMaxCycles'), { invalidCopy: t('invalidNumber') })),
        ]),

        section('gate', 'secGate', 'secGateSummary', ['greenBuildOnStop', 'dod', 'dodCommand'], [
          h(CheckRow, Object.assign({ key: 'greenBuildOnStop', label: t('greenBuildOnStop'), hint: t('greenBuildOnStopHint') }, bind('greenBuildOnStop'))),
          h(InputRow, Object.assign({ key: 'dod', label: t('dod'), hint: t('dodHint') }, bind('dod'), { invalidCopy: t('invalidDod') })),
          h(InputRow, Object.assign({ key: 'dodCommand', label: t('dodCommand'), hint: t('dodCommandHint') }, bind('dodCommand'), { invalidCopy: t('invalidCommand') })),
        ]),

        section('ce', 'secCe', 'secCeSummary', ['ceLanes', 'ceSoloLane', 'cePath'], [
          h(SelectRow, Object.assign({ key: 'ceLanes', label: t('ceLanes'), hint: t('ceLanesHint'), options: CE_LANES }, bind('ceLanes'), { invalidCopy: t('invalidNumber') })),
          h(SelectRow, Object.assign({ key: 'ceSoloLane', label: t('ceSoloLane'), hint: t('ceSoloLaneHint'), options: CE_SOLO_LANES }, bind('ceSoloLane'), { invalidCopy: t('invalidNumber') })),
          h(InputRow, Object.assign({ key: 'cePath', label: t('cePath'), hint: t('cePathHint') }, bind('cePath'))),
          h(CeStatusBlock, {
            key: 'cestatus',
            status: state.ceStatus, disabled: disabled, probing: state.probing,
            statusLabel: t('ceStatusLabel'), detectLabel: t('ceDetect'), detectingLabel: t('ceDetecting'),
            neverLabel: t('ceNever'), reviewLabel: t('ceReview'), onProbe: props.probe,
            costLabel: t('ceCost'), costFree: t('ceCostFree'),
          }),
        ]),

        // The two probe tokens are host RPC plumbing, not configuration. They
        // used to be editable text rows, which invited a user to type into a
        // field whose only legitimate writer is a button — and typing in it
        // fires a probe. They are read-only now, in a collapsed group, because
        // seeing the last request is genuinely useful when a verdict looks
        // stale. `bind()` still runs, so the fields stay covered.
        section('diag', 'secDiag', 'secDiagSummary', [], [
          h(ReadOnlyRow, { key: 'ceTok', label: t('ceProbeToken'), value: bind('ceProbeToken').text, emptyLabel: t('diagNever') }),
          h(ReadOnlyRow, { key: 'navTok', label: t('navigatorModelProbeToken'), value: bind('navigatorModelProbeToken').text, emptyLabel: t('diagNever') }),
          h('p', { key: 'diagHint', style: { margin: '4px 0 0', fontSize: 12, opacity: 0.6 } }, t('diagHint')),
        ]),

        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', paddingTop: 10, borderTop: '1px solid rgba(128,128,128,.2)', marginTop: 12 } },
          state.failed ? h('span', { style: { color: 'crimson', marginRight: 'auto' } }, t('saveFailed')) : null,
          state.dirty && !state.saving ? h('span', { style: { opacity: 0.6, fontSize: 12, marginRight: 'auto' } }, t('unsaved')) : null,
          h('button', { type: 'button', disabled: !state.dirty || state.saving, onClick: props.discard }, t('discard')),
          h('button', { type: 'button', disabled: !state.dirty || state.invalid || state.saving || disabled, onClick: props.save }, t(state.saving ? 'saving' : 'save'))));
    }

    var inject = ['slots', 'locale', 'settingsScope', 'modelDirectories'];

    function apply(ctx) {
      ctx.effect(function () {
        ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN });
      }, 'dsh-pair-programming: settings card dictionaries');

      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
      // A second, host-written namespace. Probe output is not configuration, so
      // it never lands in the section a human hand-edits in settings.yaml.
      var statusScope = ctx.settingsScope.bind({ namespace: CE_STATUS_NS });
      // The dsh model catalog (the /model dialog's own data source): feeds the
      // navigator-model dropdown and the per-model effort list. Empty groups
      // degrade the card to free-text inputs, never to a broken card.
      var navStatusScope = ctx.settingsScope.bind({ namespace: 'pair-programming-nav' });
      var catalogStore = ctx.modelDirectories && ctx.modelDirectories.catalog ? ctx.modelDirectories.catalog.store : undefined;
      var form = new CardForm(scope, [
        enumField('tddMode', TDD_MODES),
        enumField('pairStyle', PAIR_STYLES),
        enumField('defaultMode', TEAM_MODES),
        boolField('experimentalDualDrivers'),
        textField('dualDriverIntegrationCommand'),
        boolField('oracleFirst'),
        numberField('oracleForkBudget'),
        enumField('memberLifetime', MEMBER_LIFETIMES),
        textField('navigatorModel'),
        textField('navigatorEffort'),
        textField('navigatorModelProbeToken'),
        numberField('maxCyclesPerTask'),
        numberField('maxOpenRisks'),
        numberField('planningMaxArbitrations'),
        numberField('spikeMaxCycles'),
        boolField('greenBuildOnStop'),
        dodField('dod'),
        textField('dodCommand'),
        enumField('ceLanes', CE_LANES),
        enumField('ceSoloLane', CE_SOLO_LANES),
        textField('cePath'),
        textField('ceProbeToken'),
      ]);
      var project = function () {
        return {
          available: form.shell().available,
          writable: form.shell().writable,
          dirty: form.shell().dirty,
          invalid: form.shell().invalid,
          saving: form.shell().saving,
          failed: form.shell().failed,
          probing: form.shell().probing,
          testing: form.shell().testing,
          // Section collapse travels with the snapshot like every other piece
          // of view state; omitting it left `state.open` undefined and the
          // card threw on its first render.
          open: form.shell().open,
          ceStatus: (function () {
            var snap = statusScope.getSnapshot();
            return snap && snap.status === 'ready' ? snap.value : undefined;
          })(),
          navGroups: (function () {
            try {
              var cs = catalogStore ? catalogStore.getSnapshot() : undefined;
              return cs && Array.isArray(cs.groups) ? cs.groups : [];
            } catch (e) { return []; }
          })(),
          navStatus: (function () {
            var ns = navStatusScope.getSnapshot();
            return ns && ns.status === 'ready' ? ns.value : undefined;
          })(),
          fields: form.snapshotFields(),
        };
      };
      var store = form.bindStore(project);
      // The catalog loads once and refreshes itself on host events; subscribe
      // so its updates republish the card like any settings change does.
      if (catalogStore) {
        catalogStore.subscribe(function () { store.set(project()); });
        ctx.modelDirectories.catalog.load().catch(function () {});
      }

      // The section shell supplies only `close`; the section owns its own copy,
      // so bind `t` here and hand it to the card through the inject face.
      var t = ctx.locale.bind(LOCALE_NS);
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: SETTINGS_NS,
          order: 100,
          label: function () { return t('nav'); },
          inject: function () { return Object.assign({ t: t, hooks: { pairCard: store } }, form.actions()); },
        }, PairCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
