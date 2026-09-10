/** Authenticated read-only panel RPC. Reads boards; never wakes agents or appends session events. */
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateRootOf } from '../state/layout.js';
import { readTeam } from '../state/store.js';
import { readUnreadMailbox } from '../state/mailbox.js';
import { sanitizeKey } from '../state/lock.js';
import { projectPairPanel } from './panel-model.js';

export const PANEL_CHANNEL = '/pair-runtime';
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closed = team => ['DONE', 'ABORTED'].includes(team.protocol.phase);
function options(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 200) throw new Error('A sessionId is required');
  const offset = payload.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid task offset');
  const filter = payload.filter ?? 'all';
  if (!['all', 'active', 'blocked', 'done'].includes(filter)) throw new Error('Invalid task filter');
  for (const key of ['teamId', 'taskId', 'revision', 'query']) if (payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > 160)) throw new Error(`Invalid ${key}`);
  return { ...payload, offset, filter, query: payload.query ?? '' };
}
async function sessionWorkspace(ctx, id) {
  const session = ctx.sessions.get(id);
  if (typeof session?.header?.cwd === 'string') return session.header.cwd;
  const query = ctx.get?.('sessionQuery');
  if (typeof query?.observeSession !== 'function') return undefined;
  const observation = await query.observeSession(id, { projectionMode: 'none' });
  try { return typeof observation?.header?.cwd === 'string' ? observation.header.cwd : undefined; }
  finally { observation?.[Symbol.dispose]?.(); }
}
/** The browser never supplies a filesystem path or gets attempt capabilities. */
export async function readPanelSnapshot(ctx, config, request) {
  const cwd = await sessionWorkspace(ctx, request.sessionId);
  if (!cwd) return { value: { state: 'unavailable', teams: [], team: null, warnings: ['session-unavailable'] }, paths: [] };
  const root = stateRootOf(cwd, config);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  const dirs = entries.filter(e => e.isDirectory() && e.name !== 'cache').sort((a, b) => a.name.localeCompare(b.name));
  const warnings = dirs.length > 128 ? ['team-limit'] : [];
  const matches = [];
  for (let start = 0; start < Math.min(dirs.length, 128); start += 8) {
    const batch = await Promise.all(dirs.slice(start, Math.min(start + 8, 128)).map(async entry => {
      try {
        const file = join(root, entry.name, 'team.json');
        if ((await stat(file)).size > 8 * 1024 * 1024) { warnings.push('board-too-large'); return; }
        const team = await readTeam(root, entry.name);
        if (team && (team.captainSessionId === request.sessionId || team.members.some(m => m.id === request.sessionId) || team.handoffs?.some(h => h.from === request.sessionId))) return team;
      } catch (error) { if (error.code !== 'ENOENT') warnings.push('board-unreadable'); }
    }));
    matches.push(...batch.filter(Boolean));
  }
  matches.sort((a, b) => Number(closed(a)) - Number(closed(b)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const team = request.teamId ? matches.find(t => t.id === request.teamId) : matches[0];
  if (request.teamId && !team) warnings.push('team-unavailable');
  const value = { state: team ? 'ready' : warnings.length ? 'unavailable' : 'empty',
    teams: matches.slice(0, 30).map(t => ({ id: t.id, name: t.name.slice(0, 160), phase: t.protocol.phase })),
    team: team ? projectPairPanel(team, { ...request, maxResumes: config.maxTokenResumes }) : null, warnings: [...new Set(warnings)].sort() };
  if (team) value.team.mailboxes = await Promise.all(['captain', ...team.members.slice(0, 12).map(m => m.name)].map(async name => {
    try {
      const file = join(root, team.id, 'inbox', sanitizeKey(name) + '.jsonl');
      const size = (await stat(file)).size;
      if (size > 2 * 1024 * 1024) { value.warnings.push('mailbox-too-large'); return { name, pending: null }; }
      let malformed = false;
      const pending = (await readUnreadMailbox(root, team.id, name, () => { malformed = true; })).length;
      if (malformed) value.warnings.push('mailbox-unreadable');
      return { name, pending: malformed ? null : pending };
    } catch (error) { if (error.code !== 'ENOENT') value.warnings.push('mailbox-unreadable'); return { name, pending: error.code === 'ENOENT' ? 0 : null }; }
  }));
  value.warnings = [...new Set(value.warnings)].sort();
  return { value, paths: [root, ...(team ? [join(root, team.id), join(root, team.id, 'inbox')] : [])] };
}
async function existingDirectory(path) {
  for (let current = path; ; current = dirname(current)) {
    try { if ((await stat(current)).isDirectory()) return current; } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
    if (dirname(current) === current) return undefined;
  }
}
/** Install listeners before a second read, closing the read/watch race on atomic rename. */
async function waitForChange(paths, signal, waitMs, inspect) {
  const watchers = [];
  let timer, finish;
  const changed = new Promise(resolve => { finish = resolve; });
  const abort = () => finish();
  try {
    signal?.addEventListener('abort', abort, { once: true });
    for (const path of new Set(await Promise.all(paths.map(existingDirectory)))) {
      if (!path) continue;
      try { const watcher = watch(path, { persistent: false }, () => finish()); watcher.on('error', () => finish()); watchers.push(watcher); }
      catch { /* bounded timeout supplies a rescan on filesystems without watch support */ }
    }
    timer = setTimeout(finish, watchers.length ? waitMs : Math.min(waitMs, 3000));
    if (signal?.aborted || await inspect()) finish();
    await changed;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    for (const watcher of watchers) watcher.close();
  }
}
export function createPanelHandler(ctx, config, { waitMs = 20000 } = {}) {
  const pending = new Set();
  let disposed = false;
  return {
    async handle(endpoint, payload, signal) {
      if (disposed) return failure('pair-panel/unavailable', 'Panel service stopped');
      if (endpoint !== 'snapshot' && endpoint !== 'watch') return failure('pair-panel/endpoint', 'Unknown read-only endpoint');
      let request;
      try { request = options(payload); } catch (error) { return failure('pair-panel/request', error.message); }
      if (pending.size >= 32) return failure('pair-panel/busy', 'Panel reader limit reached; retry shortly');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      pending.add(controller);
      try {
        let snapshot = await readPanelSnapshot(ctx, config, request);
        const deadline = Date.now() + waitMs;
        // Atomic writes notify about their temporary file before the final rename.
        // Ignore non-semantic events; one bounded watch must not publish old state early.
        while (endpoint === 'watch' && request.revision === hash(snapshot.value) && snapshot.paths.length
          && !controller.signal.aborted && Date.now() < deadline) {
          await waitForChange(snapshot.paths, controller.signal, Math.max(1, deadline - Date.now()), async () => {
            snapshot = await readPanelSnapshot(ctx, config, request);
            return request.revision !== hash(snapshot.value);
          });
          if (!controller.signal.aborted) snapshot = await readPanelSnapshot(ctx, config, request);
        }
        if (controller.signal.aborted) return failure('pair-panel/cancelled', 'Panel read cancelled');
        return { ok: true, value: { ...snapshot.value, revision: hash(snapshot.value), observedAt: Date.now() } };
      } catch {
        return failure('pair-panel/read', 'Cannot read this session’s pair board');
      } finally { pending.delete(controller); signal?.removeEventListener('abort', abort); }
    },
    dispose() { disposed = true; for (const controller of pending) controller.abort(); },
  };
}
/** Exact Fetch routes use Connection's authenticated /api carrier on DSH 0.1.5. */
export function installPairPanel(ctx, config) {
  ctx.inject(['connection', 'sessions'], c => {
    const connection = c.get('connection');
    if (typeof connection?.fetch?.register === 'function') {
      c.effect(() => {
        const service = createPanelHandler(c, config);
        for (const endpoint of ['snapshot', 'watch']) {
          const method = 'pair-runtime/' + endpoint;
          connection.fetch.register({ path: '/api/' + method, methods: ['POST'], requestBody: 'buffered',
            async fetch(request) {
              if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return new Response('Expected JSON', {status:415});
              let body;
              try { body = await request.json(); } catch { return new Response('Invalid JSON', {status:400}); }
              if (body?.type !== 'client-request' || typeof body.rpcId !== 'string' || body.method !== method) return new Response('Invalid RPC envelope', {status:400});
              const result = await service.handle(endpoint, body.payload, request.signal);
              return Response.json({type:'server-response',rpcId:body.rpcId,result});
            }
          });
        }
        return () => service.dispose();
      }, 'pair: authenticated runtime panel');
      return;
    }
    // Legacy Connection versions own a dedicated HTTP channel.
    c.inject(['webServer'], web => {
      if (typeof connection?.rpc?.handle !== 'function') return;
      web.effect(() => {
        const service = createPanelHandler(web, config);
        const unregister = connection.rpc.handle(PANEL_CHANNEL, service.handle);
        return () => { service.dispose(); return unregister(); };
      }, 'pair: legacy runtime panel');
    });
  });
}
