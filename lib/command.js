/**
 * The `/pair` slash command and its plain-text gesture boundary.
 *
 * Adapted from @nanmicoder/dsh-agent-teams `lib/command.js` (MIT). Two
 * deterministic activation paths:
 *
 * 1. Host command — ctx.commands.register publishes the closed-namespace
 *    `/pair` command. The handler replays the exact line as an ordinary user
 *    follow-up so it stays visible in the chat; the gesture boundary then
 *    adds the deterministic activation message.
 * 2. Gesture boundary — an `agent/pre-step` listener recognizes a leading
 *    `/pair` token in genuine user messages and injects the same activation
 *    message. Covers surfaces with no command adjudication (headless CLI,
 *    API, pasted text). Only `source.kind === 'user'` messages are scanned,
 *    so injected or external text cannot forge the gesture.
 *
 * @module dsh-pair-programming/command
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** The slash command name (without the leading slash). */
export const PAIR_COMMAND = 'pair';

const GESTURE = /^\/pair(?:\s|$)/;

/**
 * The deterministic activation text. The system-prompt usage section owns the
 * full protocol; this message only switches it on for one concrete goal.
 * Recognized flags: --light, --tdd=enforce|coach|off, --style=traditional|strong|ping-pong.
 * @param {string} goal - the user-supplied goal, or '' for a bare invocation.
 */
export function buildActivationDirective(goal) {
  const goalLine = goal === ''
    ? 'The goal was not given — ask the user what the pair-programming team should accomplish.'
    : `Goal: ${goal}`;
  const light = /\s--light(?:\s|$)/.test(goal) || /轻量结对|轻量级/.test(goal);
  const tddMatch = /--tdd=(enforce|coach|off)(?:\s|$)/.exec(goal);
  const styleMatch = /--style=(traditional|strong|ping-pong)(?:\s|$)/.exec(goal);
  const lines = [
    'The user invoked the `/pair` command. Activate the pair-programming protocol from your instructions now: you are the captain of an Agile pair-programming team (Driver + Navigator' + (light ? '' : ' + Challenger') + ').',
    light ? 'Mode: light (Driver + Navigator only, no Challenger, no retrospective unless asked).' : 'Mode: full.',
  ];
  if (tddMatch !== null) lines.push(`TDD mode: ${tddMatch[1]} — pass tdd_mode="${tddMatch[1]}" to pair_start (enforce = tool-mandated RED->GREEN->REFACTOR, coach = recommended, off = legacy report cycle).`);
  if (styleMatch !== null) lines.push(`Pairing style: ${styleMatch[1]} — pass style="${styleMatch[1]}" to pair_start.`);
  lines.push(goalLine);
  return lines.join('\n');
}

/**
 * The goal of the latest start-anchored `/pair` gesture in genuine user
 * messages, or undefined when no message carries one. '' means a bare `/pair`.
 * @param {readonly object[]} messages - the step's claimed batch.
 */
export function invokedPairGoal(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.source.kind !== 'user') continue;
    for (const block of message.content) {
      if (block.type !== 'text') continue;
      const text = block.text.trimStart();
      if (!GESTURE.test(text)) continue;
      return text.slice(PAIR_COMMAND.length + 1).trim();
    }
  }
  return undefined;
}

/**
 * Register the closed-namespace `/pair` host command. The handler preserves
 * the exact submitted slash line as an ordinary user follow-up; the gesture
 * boundary injects the activation directive and wakes the captain.
 */
export function registerPairCommand(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: PAIR_COMMAND,
    description: 'run a goal with an Agile pair-programming team (you become the captain)',
    input: { hint: '<goal — what the pair team should accomplish> [--light] [--tdd=enforce|coach|off] [--style=traditional|strong|ping-pong]' },
    handler(invocation) {
      const goal = invocation.rawInput.trim();
      if (goal === '') {
        return {
          kind: 'error',
          text: `Usage: /${PAIR_COMMAND} <goal> [--light] [--tdd=enforce|coach|off] [--style=traditional|strong|ping-pong]`,
        };
      }
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `/${PAIR_COMMAND}${invocation.rawInput}` }],
        source: { kind: 'user' },
      }));
      return {
        kind: 'success',
        text: `Pair-programming activated — assembling a team for: ${goal}`,
      };
    },
  }), 'pair-programming: slash command');
}

/**
 * Install the `agent/pre-step` gesture boundary: a claimed user message
 * starting with `/pair` gains the deterministic activation message appended
 * after every other injection, closest to the model's answer.
 */
export function installPairGestureBoundary(ctx) {
  ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const goal = invokedPairGoal(messages);
    if (goal === undefined) return decision;
    signal.throwIfAborted();
    const activation = createUserMessage({
      content: [{ type: 'text', text: buildActivationDirective(goal) }],
      source: { kind: 'pair-programming-command', ...(goal === '' ? {} : { goal }) },
    });
    return { kind: 'enter', messages: [...decision.messages, activation] };
  });
}
