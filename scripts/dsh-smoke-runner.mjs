/** Test-only replacement for dsh-headless's runner; loads the real DSH profile.
 * Selects a model per session and records bounded evidence, without changing settings.
 * Not part of the plugin runtime or a substitute for a held-out quality benchmark.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { Config } from '@deepseek-ai/dsh-headless';

export { Config };
export const name = 'pair-native-smoke-runner';
export const inject = ['agents', 'sessions', 'headlessStartup'];

export function apply(ctx, config) {
  run(ctx, config.task).catch(error => {
    process.stderr.write(`DSH_SMOKE_ERROR ${String(error.message)}\n`);
    ctx.get('appExit')(1);
  });
}

async function run(ctx, task) {
  await ctx.get('loader')?.await();
  const selection = {
    provider: process.env.DSH_PAIR_SMOKE_PROVIDER || 'opencode-go-muse',
    model: process.env.DSH_PAIR_SMOKE_MODEL || 'muse-spark-1.3-contributor',
  };
  const output = process.env.DSH_PAIR_SMOKE_OUTPUT;
  if (!output) throw new Error('DSH_PAIR_SMOKE_OUTPUT must name a result file');
  const receipt = { selection, cwd: process.cwd(), startedAt: new Date().toISOString(), sessions: [], routes: [], tools: [], toolCount: 0, errors: [] };
  const stop = ctx.on('session/event', (session, event) => {
    if (session.header.cwd !== process.cwd()) return;
    if (!receipt.sessions.includes(session.id)) receipt.sessions.push(session.id);
    if (event.type === 'request/context' && receipt.routes.length < 100) receipt.routes.push({ sessionId: session.id, provider: event.data.provider, model: event.data.model });
    if (event.type === 'tool/call' || event.type === 'tool/code-dispatch') receipt.toolCount++;
    if (receipt.tools.length < 2000 && event.type === 'tool/call') {
      const call = { sessionId: session.id, name: event.data.name };
      if (call.name === 'pair_verify') {
        try {
          const args = JSON.parse(event.data.arguments);
          call.verification = { cycleId: args.cycle_id, stage: args.stage, verdict: args.verdict };
        } catch { /* Invalid arguments remain visible as tool failures. */ }
      }
      receipt.tools.push(call);
    }
    if (receipt.tools.length < 2000 && event.type === 'tool/code-dispatch') receipt.tools.push({ sessionId: session.id, name: event.data.name ?? 'unknown', isError: event.data.isError === true });
    if (event.type === 'tool/result' && event.data.error && receipt.errors.length < 100) receipt.errors.push({ sessionId: session.id, ...event.data.error,
      message: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('').slice(0, 1500) });
    if (event.type === 'turn/end') {
      process.stdout.write(`DSH_TURN ${session.id} ${event.data.reason.kind}\n`);
      if (event.data.reason.kind === 'error') receipt.errors.push({ sessionId: session.id, code: event.data.reason.error.code, message: String(event.data.reason.error.message).slice(0, 1000) });
    }
  });
  const timeoutMs = Number(process.env.DSH_PAIR_SMOKE_TIMEOUT_MS || 600000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw new Error('invalid smoke timeout');
  let handle;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    receipt.status = 'timeout';
    receipt.endedAt = new Date().toISOString();
    writeFile(output, JSON.stringify(receipt, null, 2)).finally(() => ctx.get('appExit')(1));
  }, timeoutMs);
  try {
    handle = await ctx.agents.create({
      sessionId: brandString(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: selection,
      setup: agentCtx => { installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
    });
    const { agent } = handle;
    receipt.captainSessionId = agent.id;
    process.stdout.write(`DSH_SMOKE_START ${agent.id} ${selection.provider}/${selection.model}\n`);
    await agent.whenIdle();
    const first = agent.session.seq;
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
    await agent.whenIdle();
    // The stock headless runner exits at the captain's first idle edge. A pair
    // session has independent children: wait for its durable terminal outcome.
    // This observer sends no nudges and never writes the board.
    const expectedTeam = process.env.DSH_PAIR_SMOKE_EXPECT_TEAM;
    if (expectedTeam) {
      if (!/^[A-Za-z0-9._-]+$/.test(expectedTeam)) throw new Error('invalid expected team id');
      while (!timedOut) {
        try {
          const board = JSON.parse(await readFile(join(process.cwd(), '.pair-programming', expectedTeam, 'team.json'), 'utf8'));
          if (['DONE', 'ABORTED'].includes(board.protocol.phase)) {
            receipt.team = {
              id: board.id, phase: board.protocol.phase,
              members: board.members.map(({ id, role, provider, model, status }) => ({ id, role, provider, model, status })),
              tasks: board.tasks.map(({ id, status, gatePassId }) => ({ id, status, gatePassId })),
              cycleCount: board.protocol.cycles.length,
              cycles: board.protocol.cycles.map(({ id, rejections, verify }) => ({ id, rejections, verdict: verify?.verdict, category: verify?.category })),
              stats: board.protocol.stats,
            };
            break;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      if (timedOut) return;
      await agent.whenIdle();
    }
    await ctx.sessions.flush(agent.session);
    let reason;
    let finalText = '';
    for (let seq = first; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(SessionSeq(seq));
      if (event.type === 'turn/end') reason = event.data.reason;
      if (event.type === 'assistant/message') {
        const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
        if (text) finalText = text;
      }
    }
    receipt.finalText = finalText.slice(0, 12000);
    receipt.status = reason?.kind === 'completed' && (!expectedTeam || receipt.team?.phase === 'DONE') ? 'completed' : 'failed';
    receipt.endedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(receipt, null, 2));
    process.stdout.write(`DSH_SMOKE_RESULT ${receipt.status} ${receipt.tools.length} tool calls; ${output}\n${finalText}\n`);
    ctx.get('appExit')(receipt.status === 'completed' ? 0 : 1);
  } finally {
    clearTimeout(timer);
    stop();
    if (!timedOut) await handle?.dispose();
  }
}
