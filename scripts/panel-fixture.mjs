/** Disposable board + real DSH session/connection bridge. No agents or model calls. */
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTeamDir, writeTeam } from '../lib/state/store.js';
import { initialProtocolState } from '../lib/protocol/machine.js';
import { gateStateFingerprint } from '../lib/protocol/gate.js';
import { resolveConfig } from '../lib/defaults.js';
import { installPairPanel } from '../lib/runtime/panel-rpc.js';

export function demoBoard() {
  const now = Date.now();
  const subjects = ['梳理训练流程与验收条件', '实现题库与难度筛选', '保存练习记录与进度', '完善判题超时与错误反馈', '实现训练概览与连续练习', '验证跨模块恢复流程', '统一空状态与视觉细节', '整理发布检查与使用指引'];
  const protocol = initialProtocolState(); protocol.phase = 'CYCLING';
  const team = { id: 'panel-demo', name: '算法训练台 · Sprint 04', goal: '让每一次练习都有清晰反馈，让中断后的训练可以顺利继续。',
    mode: 'full', captainSessionId: 'panel-captain', createdAt: now - 3600000, updatedAt: now, taskSeq: 8,
    members: ['driver', 'driver-2', 'navigator'].map((name, i) => ({ id: 'panel-seat-' + i, name, role: i < 2 ? 'driver' : 'navigator', status: i < 2 ? 'working' : 'idle', joinedAt: now - 3600000 })),
    tasks: subjects.map((subject, i) => ({ id: 't-' + (i + 1), subject, description: '围绕用户从选题到完成练习的实际流程，处理正常路径、失败恢复与协作边界。',
      status: i < 3 ? 'completed' : i < 6 ? 'in_progress' : 'pending', assignee: i % 2 ? 'driver-2' : 'driver',
      dependencies: i === 6 ? ['t-4', 't-5'] : i === 7 ? ['t-6', 't-7'] : [], priority: i === 3 ? 0 : i < 6 ? 1 : 2,
      acceptanceRefs: ['UC-1.AC-' + (i + 1)], story: { acceptance_criteria: ['正常操作有明确结果', '失败时保留用户输入并提供重试入口', '刷新后可恢复已保存进度'] },
      oracle: i < 6 ? { caseRefs: ['UC-1.AC-' + (i + 1)], command: 'SECRET-COMMAND' } : undefined,
      attemptId: 'SECRET-CAPABILITY-' + i, createdAt: now - 3500000 + i * 120000, updatedAt: now - (8 - i) * 60000 })),
    useCases: [{ id: 'UC-1', actor: '练习者', intent: '完成并恢复一次训练', outcome: '得到可信反馈', acceptanceCriteria: subjects.map((text, i) => ({ id: 'UC-1.AC-' + (i + 1), text })) }],
    protocol, parallel: { integrations: {} }, product: { discoveries: [{ id: 'discovery-1', status: 'untriaged', observation: '判题等待中离开页面，用户不知道任务是否仍在继续', userValue: '返回时看见当前进度，避免重复提交' }] } };
  for (let i = 0; i < 6; i++) protocol.cycles.push({ id: 'c-t-' + (i + 1) + '-1', taskId: 't-' + (i + 1), step: i < 3 ? 'VERIFIED' : i === 5 ? 'GREEN' : 'GO', openedAt: now - 2800000 + i * 240000,
    ...(i < 3 ? { verify: { verdict: 'accept', at: now - 2000000 + i * 240000 } } : {}) });
  for (let i = 0; i < 3; i++) {
    const task = team.tasks[i]; task.gatePassId = 'gate-' + task.id;
    protocol.gatePasses.push({ id: task.gatePassId, taskId: task.id, binding: { gateStateSha: gateStateFingerprint(team, task.id) } });
    team.parallel.integrations[task.id] = { head: 'example' + i, at: task.updatedAt };
  }
  return team;
}

export async function mountPanelFixture({ serve, board = demoBoard() } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'pair-panel-'));
  const config = resolveConfig({});
  const root = join(workspace, config.stateDir);
  const routes = new Map(), token = randomUUID(), ctx = new Context();
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } }, true);
  ctx.plugin(SessionStore);
  await new Promise(resolve => setTimeout(resolve, 40));
  ctx.sessions.create('panel-captain', { meta: { cwd: workspace } });
  ctx.sessions.create('outsider', { meta: { cwd: workspace } });
  // Only the HTTP listener/auth policy are fixtures. The RPC bridge and session store are DSH.
  new HostConnectionService(ctx, [], { isAuthenticated: req => req.headers['x-panel-fixture'] === token });
  installPairPanel(ctx, config);
  await new Promise(resolve => setTimeout(resolve, 40));
  if (board) await createTeamDir(root, board);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const route = [...routes.values()].find(r => path === r.path || path.startsWith(r.path + '/'));
      if (route) return await route.handler(req, res);
      if (serve && await serve(req, res, { token, board, root, save: () => writeTeam(root, board) })) return;
      res.writeHead(404); res.end('not found');
    } catch (error) { res.writeHead(500); res.end(String(error.stack)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return { ctx, config, workspace, root, board, url, token, routes,
    async rpc(method, payload, signal) {
      const response = await fetch(url + '/pair-runtime/' + method, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-panel-fixture': token },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
      if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());
      return (await response.json()).result;
    },
    async close() { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}
