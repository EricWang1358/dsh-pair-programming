/** Identity-owned durable mail reader, including records already admitted by the host. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { requireAgent, requireParticipantTeam, stateRootFor } from './shared.js';
import { readTeam } from '../state/store.js';
import { readMailbox } from '../state/mailbox.js';
import { withLock } from '../state/lock.js';
import { teamLockKey } from '../state/layout.js';

export function registerMailboxTools(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'pair_mailbox_read',
    description: 'Read your OWN durable mailbox message by id, including after notification delivery. Oversized messages arrive as references. Pages contain at most 4000 UTF-16 chars: follow next_offset until null. This read does not mark work completed or grant access to another recipient mailbox.',
    parameters: {
      message_id: { type: 'string', required: true, description: 'Exact message id from your delivered reference.' },
      offset: { type: 'number', description: 'Zero-based UTF-16 offset, default 0; use next_offset from the previous page.' },
      max_chars: { type: 'number', description: 'Integer page size from 1 to 4000, default 4000.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const offset = args.offset ?? 0, limit = args.max_chars ?? 4000;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative safe integer');
      if (!Number.isInteger(limit) || limit < 1 || limit > 4000) throw new Error('max_chars must be an integer from 1 to 4000');
      const agent = requireAgent(exec), stateRoot = stateRootFor(agent, config);
      const located = await requireParticipantTeam(agent, config);
      return withLock(teamLockKey(stateRoot, located.id), async () => {
        const team = await readTeam(stateRoot, located.id);
        const identity = team?.captainSessionId === agent.id ? 'captain'
          : team?.members.find(member => member.id === agent.id && member.status !== 'removed')?.name;
        if (identity === undefined) throw new Error('you are not an active recipient of this team');
        const message = (await readMailbox(stateRoot, team.id, identity)).find(row => row.id === args.message_id && row.to === identity);
        if (message === undefined) throw new Error('message not found in your own mailbox');
        if (offset > message.content.length) throw new Error('offset exceeds the message length');
        let end = Math.min(message.content.length, offset + limit);
        // Do not split a surrogate pair when the page can still make progress.
        if (end < message.content.length && end > offset + 1 && /[\uD800-\uDBFF]/.test(message.content[end - 1])) end--;
        return { message_id: message.id, offset, content: message.content.slice(offset, end),
          next_offset: end < message.content.length ? end : null, total_chars: message.content.length,
          notification_accepted: message.deliveredAt !== undefined };
      });
    },
  }));
}
