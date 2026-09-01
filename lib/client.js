/**
 * Browser-side client module: the Settings → Plugins card for the
 * `pair-programming` namespace.
 *
 * Loaded by the web shell as a classic script through
 * `window.__ModuleLoader__.load` (no ESM syntax, no build step — this file is
 * shipped as authored and served verbatim to the browser). It binds the same
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
    var TEAM_MODES = ['full', 'light'];

    var EN = {
      cardTitle: 'Pair programming',
      cardDescription: 'The agile pair-programming protocol: Driver / Navigator / Challenger, Test-First cycles and the quality gate.',
      tddMode: 'TDD enforcement', tddModeHint: 'enforce: RED before GREEN is tool-mandated · coach: recommended · off: legacy report cycle.',
      pairStyle: 'Pairing style', pairStyleHint: 'traditional · strong (idea holder dictates) · ping-pong (author / implementer alternate).',
      defaultMode: 'Default team mode', defaultModeHint: 'full adds the Challenger; light is Driver + Navigator.',
      maxCyclesPerTask: 'Max cycles per task', maxCyclesPerTaskHint: 'Hard budget — after it the captain must consult you. Blank uses the composed value.',
      maxOpenRisks: 'Max open risks', maxOpenRisksHint: 'Team-wide cap on OPEN non-P0 risk tickets; a P0 bypasses it. Blank uses the composed value.',
      planningMaxArbitrations: 'Planning arbitrations per task', planningMaxArbitrationsHint: 'Cap on disputes resolved while a task is still being planned; 0 is refused. Blank uses the composed value.',
      spikeMaxCycles: 'Spike max cycles', spikeMaxCyclesHint: 'A spike exits with a decision, not code.',
      greenBuildOnStop: 'Green build on stop', greenBuildOnStopHint: 'Nobody goes home on a red build: pair_stop demands fresh whole-suite evidence.',
      dod: 'Definition of Done', dodHint: 'Comma-separated item ids, e.g. all_accepted,verify_evidence,test_first. Blank = protocol defaults.',
      overridden: 'Overridden', reset: 'reset', baseLabel: 'composed',
      save: 'Save', saving: 'Saving…', discard: 'Discard', unsaved: 'Unsaved changes',
      saveFailed: 'The deployment did not accept these values — your draft is kept.',
      readOnly: 'Settings are read-only in this deployment.',
      invalidNumber: 'Enter an integer ≥ 1, or leave blank for the composed value.',
      invalidDod: 'Unknown DoD item; valid ids: all_accepted, no_blocking_risks, verify_evidence, decisions_documented, test_first, spike_outcome.',
    };
    var ZH = {
      cardTitle: '结对编程',
      cardDescription: '敏捷结对协议：Driver / Navigator / Challenger、测试先行循环与质量门禁。',
      tddMode: 'TDD 强制程度', tddModeHint: 'enforce：先 RED 后 GREEN 由工具强制 · coach：推荐不强制 · off：旧式报告循环。',
      pairStyle: '结对风格', pairStyleHint: 'traditional · strong（想法持有者口述）· ping-pong（测试作者与实现者交替）。',
      defaultMode: '默认团队模式', defaultModeHint: 'full 含 Challenger；light 为 Driver + Navigator。',
      maxCyclesPerTask: '单任务最大循环数', maxCyclesPerTaskHint: '硬预算，超限队长必须向用户请示。留空使用组合基线值。',
      maxOpenRisks: '风险票开放上限', maxOpenRisksHint: '全队 OPEN 非 P0 风险票上限；P0 不受此限。留空使用组合基线值。',
      planningMaxArbitrations: '单任务规划仲裁上限', planningMaxArbitrationsHint: '任务进入开发前可裁决的争议数上限；0 被拒。留空使用组合基线值。',
      spikeMaxCycles: 'Spike 循环上限', spikeMaxCyclesHint: 'Spike 以决策收尾，不产代码。',
      greenBuildOnStop: '停止时要求绿灯构建', greenBuildOnStopHint: '没有人带着红构建回家：pair_stop 需新鲜全量测试证据。',
      dod: '完成标准（DoD）', dodHint: '逗号分隔条目 id，如 all_accepted,verify_evidence,test_first。留空 = 协议默认。',
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

    /* ---- CardForm: staged drafts over a settingsScope ---------------------- */
    function CardForm(scope, specs) {
      var self = { scope: scope, specs: specs, staged: new Map(), listeners: new Set(), saving: false, failed: false };
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
          saving: self.saving, failed: self.failed,
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
          save: self.save, discard: self.discard,
        };
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

    function PairCard(props) {
      var t = props.t;
      var state = props.usePairCard(function (s) { return s; });
      if (!state.available) return null;
      var disabled = !state.writable;
      function bind(name) {
        var f = state.fields[name];
        return Object.assign({}, f, {
          disabled: disabled,
          overriddenLabel: t('overridden'), resetLabel: t('reset'), baseLabel: t('baseLabel'),
          onEdit: function (v) { props.edit(name, v); },
          onReset: function () { props.resetField(name); },
        });
      }
      return h('li', { style: { listStyle: 'none', border: '1px solid rgba(128,128,128,.35)', borderRadius: 12, padding: '4px 16px 12px', margin: '0 0 16px' } },
        h('h3', { style: { margin: '8px 0 2px' } }, t('cardTitle')),
        h('p', { style: { margin: '0 0 6px', fontSize: 13, opacity: 0.7 } }, t('cardDescription')),
        disabled ? h('p', { style: { fontSize: 13 } }, t('readOnly')) : null,
        h(SelectRow, Object.assign({ label: t('tddMode'), hint: t('tddModeHint'), options: TDD_MODES }, bind('tddMode'), { invalidCopy: t('invalidNumber') })),
        h(SelectRow, Object.assign({ label: t('pairStyle'), hint: t('pairStyleHint'), options: PAIR_STYLES }, bind('pairStyle'), { invalidCopy: t('invalidNumber') })),
        h(SelectRow, Object.assign({ label: t('defaultMode'), hint: t('defaultModeHint'), options: TEAM_MODES }, bind('defaultMode'), { invalidCopy: t('invalidNumber') })),
        h(InputRow, Object.assign({ label: t('maxCyclesPerTask'), hint: t('maxCyclesPerTaskHint'), numeric: true }, bind('maxCyclesPerTask'), { invalidCopy: t('invalidNumber') })),
        h(InputRow, Object.assign({ label: t('maxOpenRisks'), hint: t('maxOpenRisksHint'), numeric: true }, bind('maxOpenRisks'), { invalidCopy: t('invalidNumber') })),
        h(InputRow, Object.assign({ label: t('planningMaxArbitrations'), hint: t('planningMaxArbitrationsHint'), numeric: true }, bind('planningMaxArbitrations'), { invalidCopy: t('invalidNumber') })),
        h(InputRow, Object.assign({ label: t('spikeMaxCycles'), hint: t('spikeMaxCyclesHint'), numeric: true }, bind('spikeMaxCycles'), { invalidCopy: t('invalidNumber') })),
        h(CheckRow, Object.assign({ label: t('greenBuildOnStop'), hint: t('greenBuildOnStopHint') }, bind('greenBuildOnStop'))),
        h(InputRow, Object.assign({ label: t('dod'), hint: t('dodHint') }, bind('dod'), { invalidCopy: t('invalidDod') })),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', paddingTop: 10 } },
          state.failed ? h('span', { style: { color: 'crimson', marginRight: 'auto' } }, t('saveFailed')) : null,
          state.dirty && !state.saving ? h('span', { style: { opacity: 0.6, fontSize: 12, marginRight: 'auto' } }, t('unsaved')) : null,
          h('button', { type: 'button', disabled: !state.dirty || state.saving, onClick: props.discard }, t('discard')),
          h('button', { type: 'button', disabled: !state.dirty || state.invalid || state.saving || disabled, onClick: props.save }, t(state.saving ? 'saving' : 'save'))));
    }

    var inject = ['slots', 'locale', 'settingsScope'];

    function apply(ctx) {
      ctx.effect(function () {
        ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN });
      }, 'dsh-pair-programming: settings card dictionaries');

      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
      var form = new CardForm(scope, [
        enumField('tddMode', TDD_MODES),
        enumField('pairStyle', PAIR_STYLES),
        enumField('defaultMode', TEAM_MODES),
        numberField('maxCyclesPerTask'),
        numberField('maxOpenRisks'),
        numberField('planningMaxArbitrations'),
        numberField('spikeMaxCycles'),
        boolField('greenBuildOnStop'),
        dodField('dod'),
      ]);
      var store = form.bindStore(function () {
        return {
          available: form.shell().available,
          writable: form.shell().writable,
          dirty: form.shell().dirty,
          invalid: form.shell().invalid,
          saving: form.shell().saving,
          failed: form.shell().failed,
          fields: {
            tddMode: form.field('tddMode'),
            pairStyle: form.field('pairStyle'),
            defaultMode: form.field('defaultMode'),
            maxCyclesPerTask: form.field('maxCyclesPerTask'),
            maxOpenRisks: form.field('maxOpenRisks'),
            planningMaxArbitrations: form.field('planningMaxArbitrations'),
            spikeMaxCycles: form.field('spikeMaxCycles'),
            greenBuildOnStop: form.field('greenBuildOnStop'),
            dod: form.field('dod'),
          },
        };
      });

      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_NS,
          locale: LOCALE_NS,
          inject: function () { return Object.assign({ hooks: { pairCard: store } }, form.actions()); },
        }, PairCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
