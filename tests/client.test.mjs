/** browser client surface: classic-script module shape + apply() registration, vm-tested. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT_ID = '@ericwang1358/dsh-pair-programming';

/** Minimal stubs for the browser shell: react.createElement, snapshot store, settingsScope, slots, locale. */
function loadClient(check) {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  check(!/^\s*(import|export)\s/m.test(src), 'client is a classic script (no ESM syntax)');

  let loaded = null;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  const store = {
    createSnapshotStore: (initial) => {
      let value = initial;
      const subs = new Set();
      const hook = (selector) => selector(value);       // callable React hook + store surface
      hook.getSnapshot = () => value;
      hook.set = (next) => { value = next; subs.forEach(l => l()); };
      hook.subscribe = (l) => { subs.add(l); return () => subs.delete(l); };
      return hook;
    },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => { loaded = m; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  check(loaded !== null && loaded.id === CLIENT_ID, 'client registers under the package id');
  check(typeof loaded.factory === 'function', 'factory present');
  const api = loaded.factory((name) => {
    if (name === 'react') return react;
    if (name === '@deepseek-ai/dsh-client-store') return store;
    throw new Error(`unexpected require: ${name}`);
  });
  check(typeof api.apply === 'function', 'apply exported');
  check(Array.isArray(api.inject) && api.inject.includes('settingsScope') && api.inject.includes('slots') && api.inject.includes('locale'), 'service inject list');
  return { api, react, store };
}

/** fake browser ctx: one settingsScope namespace with base/user/value layers and a ready snapshot. */
function fakeCtx() {
  const user = { tddMode: 'coach' };
  const base = { tddMode: 'enforce', pairStyle: 'traditional', defaultMode: 'full', maxCyclesPerTask: 12, planningMaxArbitrations: 2, spikeMaxCycles: 2, greenBuildOnStop: true, dod: '' };
  const listeners = new Set();
  const writes = [];
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { ...base, ...user }, base, user, revision: 3, writable: true, mode: 'host' }),
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    set: (field, value) => { writes.push(['set', field, value]); user[field] = value; listeners.forEach(l => l()); return Promise.resolve(); },
    unset: (field) => { writes.push(['unset', field]); delete user[field]; listeners.forEach(l => l()); return Promise.resolve(); },
  };
  const locale = { registered: null };
  const slots = { injectedName: null, registration: null };
  return {
    scope, writes, locale, slots,
    ctx: {
      effect: (fn) => fn(),
      settingsScope: { bind: ({ namespace }) => { slots.boundNamespace = namespace; return scope; }, },
      locale: { register: (ns, copy) => { locale.registered = { ns, copy }; }, },
      slots: {
        inject: (name, gen) => { slots.injectedName = name; for (const reg of gen()) slots.registration = reg; },
        register: (meta, component) => meta,
      },
    },
    setUser: (next) => { for (const [k, v] of Object.entries(next)) user[k] = v; listeners.forEach(l => l()); },
  };
}

export async function run(check) {
  const { api } = loadClient(check);

  const env = fakeCtx();
  api.apply(env.ctx);

  check(env.slots.boundNamespace === 'pair-programming', 'binds the host settings namespace pair-programming');
  check(env.locale.registered?.ns === 'settings.pair-programming', 'locale registered under its own namespace');
  const copy = env.locale.registered?.copy;
  const needed = ['cardTitle', 'tddMode', 'pairStyle', 'defaultMode', 'maxCyclesPerTask', 'maxOpenRisks', 'planningMaxArbitrations', 'spikeMaxCycles', 'greenBuildOnStop', 'dod', 'save', 'discard', 'reset', 'overridden', 'baseLabel', 'readOnly', 'saveFailed', 'unsaved', 'saving', 'invalidNumber'];
  check(needed.every(k => typeof copy?.zh?.[k] === 'string' && typeof copy?.en?.[k] === 'string'), 'both locales cover every needed key');
  check(env.slots.injectedName === 'settings.plugin.item', 'injected into settings.plugin.item slot');
  check(env.slots.registration?.key === 'pair-programming', 'card keyed by the settings namespace');

  // drive the card through the store the slot would hand to React
  const store = env.slots.registration.inject().hooks.pairCard;
  const state = store.getSnapshot();
  check(state.available === true && state.writable === true, 'card available on a ready writable namespace');
  check(state.fields.tddMode.text === 'coach' && state.fields.tddMode.overridden === true, 'user override surfaces as coach + overridden');
  check(state.fields.maxCyclesPerTask.text === '12' && state.fields.maxCyclesPerTask.overridden === false, 'composed value renders unmarked');

  const actions = env.slots.registration.inject();
  actions.edit('maxCyclesPerTask', '8');
  const dirty = store.getSnapshot();
  check(dirty.dirty === true && dirty.fields.maxCyclesPerTask.text === '8', 'staged draft is local until save');
  actions.save();
  await new Promise(r => setTimeout(r, 0));
  check(env.writes.some(w => w[0] === 'set' && w[1] === 'maxCyclesPerTask' && w[2] === 8), 'save writes the parsed number through the scope');
  check(store.getSnapshot().dirty === false, 'clean after landing');

  // invalid input blocks save
  actions.edit('spikeMaxCycles', '0');
  check(store.getSnapshot().invalid === true, 'budget < 1 marked invalid');
  const before = env.writes.length;
  actions.save();
  check(env.writes.length === before, 'invalid draft refuses to write');
  actions.discard();
  check(store.getSnapshot().dirty === false, 'discard drops the draft');

  // reset-to-composed: overridden tddMode -> base enforce
  actions.resetField('tddMode');
  actions.save();
  await new Promise(r => setTimeout(r, 0));
  check(userCleared(env), 'reset writes the composed value back');

  // unavailable namespace => card silent
  const quiet = fakeCtx();
  quiet.scope.getSnapshot = () => ({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'memory' });
  quiet.ctx.settingsScope.bind = ({ namespace }) => { quiet.slots.boundNamespace = namespace; return quiet.scope; };
  api.apply(quiet.ctx);
  const qstore = quiet.slots.registration.inject().hooks.pairCard;
  check(qstore.getSnapshot().available === false, 'unserved namespace keeps the card silent');
}

function userCleared(env) {
  return env.writes.some(w => w[0] === 'set' && w[1] === 'tddMode' && w[2] === 'enforce');
}
