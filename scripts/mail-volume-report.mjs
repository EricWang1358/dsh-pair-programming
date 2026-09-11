/**
 * Where the protocol's bytes actually go, measured on a real board (#15).
 *
 * The issue carried a number - 446 KB of protocol traffic in one session - and an
 * interpretation: much of it the same obligation restated. An interpretation is not a
 * measurement, and the fix that followed (folding the repeated owed-call footer) can
 * only claim what it removed if the composition is visible. This reads a state
 * directory READ-ONLY and reports, per team and recipient:
 *
 *   mail     the durable message bytes themselves
 *   prompt   what one delivery of that backlog costs through the real builder
 *   owed     the share of the footer that is the recipient's owed call
 *   overhead prompt - mail
 *
 * The owed share is isolated by rebuilding the same prompt against an empty board: the
 * difference is the obligation segment and nothing else. Run it against any workspace:
 *
 *   node scripts/mail-volume-report.mjs <workspace> [--state-dir .pair-programming]
 *
 * @module dsh-pair-programming/scripts/mail-volume-report
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTeam } from '../lib/state/store.js';
import { readMailbox } from '../lib/state/mailbox.js';
import { decodeMessage } from '../lib/protocol/messages.js';
import { boundedMailboxPrompt, selectDeliveryMessages } from '../lib/runtime/mail-delivery.js';

const kb = bytes => Math.round(bytes / 1024);

export async function mailVolumeReport(workspace, stateDir = '.pair-programming') {
  const stateRoot = join(workspace, stateDir);
  let teams = [];
  try { teams = await readdir(stateRoot, { withFileTypes: true }); } catch { return { error: 'no state directory at ' + stateRoot, rows: [], totals: { mail: 0, prompt: 0, owed: 0, messages: 0 } }; }
  const rows = [];
  const senders = new Map();
  const types = new Map();
  const largest = [];
  const totals = { mail: 0, prompt: 0, owed: 0, messages: 0, selectedMail: 0 };
  for (const entry of teams) {
    if (!entry.isDirectory()) continue;
    const team = await readTeam(stateRoot, entry.name).catch(() => undefined);
    if (team === undefined) continue;
    const recipients = ['captain', ...(team.members ?? []).filter(m => m.status !== 'removed').map(m => m.name)];
    for (const recipient of recipients) {
      const mailbox = await readMailbox(stateRoot, team.id, recipient).catch(() => []);
      if (mailbox.length === 0) continue;
      const bytes = message => Buffer.byteLength(String(message.content ?? ''), 'utf8');
      const mail = mailbox.reduce((sum, message) => sum + bytes(message), 0);
      const selected = selectDeliveryMessages(mailbox, team);
      // Like for like: what ONE delivery of the selected batch costs on the wire, against
      // the bytes of the messages that batch actually carries. Comparing the batch cost
      // with the whole backlog (the first version of this script) reports a negative
      // overhead and answers nothing.
      const selectedMail = selected.reduce((sum, message) => sum + bytes(message), 0);
      const prompt = boundedMailboxPrompt(selected, team, recipient, {}, mailbox.length).bytes;
      // The same batch against a board with nothing owed: the delta is the owed segment.
      const empty = boundedMailboxPrompt(selected, { id: team.id, protocol: { cycles: [] }, members: team.members }, recipient, {}, mailbox.length).bytes;
      const owed = prompt - empty;
      // A delivery can be SMALLER than the messages it covers: an oversized record is
      // replaced by a reference and read on demand. Reporting the two numbers is enough
      // to see that; claiming an "overhead" was the mistake in the first version.
      rows.push({ team: team.id, phase: team.protocol?.phase, recipient, messages: mailbox.length, selected: selected.length,
        mail, selectedMail, prompt, owed, compressed: prompt < selectedMail });
      // Attribution: which senders, which message types and which single messages carry
      // the backlog. Without this the total says the volume exists but not what it is.
      for (const message of mailbox) {
        const keySender = String(message.from ?? '?');
        const keyType = String(message.type ?? decodeMessage(message.content)?.type ?? 'plain');
        senders.set(keySender, (senders.get(keySender) ?? 0) + bytes(message));
        types.set(keyType, (types.get(keyType) ?? 0) + bytes(message));
        largest.push({ bytes: bytes(message), team: team.id, recipient, from: keySender, type: keyType, id: message.id });
      }
      totals.mail += mail; totals.prompt += prompt; totals.owed += owed; totals.messages += mailbox.length;
      totals.selectedMail += selectedMail;
    }
  }
  const bySender = [...senders.entries()].sort((a, b) => b[1] - a[1]);
  const byType = [...types.entries()].sort((a, b) => b[1] - a[1]);
  const top = largest.sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return { rows, totals, bySender, byType, top };
}
/**
 * What one message TYPE is actually made of. The volume number cannot answer the
 * composition question: a letter whose bulk is its envelope is padding and can be
 * bounded, while a letter whose bulk is its own decision text is a record. Measured on
 * the archived board: 690 ARBITRATE letters, median 2 KB, of which decision 54%,
 * evidence 24%, rationale 16% - content, not wrapper.
 */
export async function dissect(workspace, stateDir = '.pair-programming', type = 'ARBITRATE') {
  const stateRoot = join(workspace, stateDir);
  let entries = [];
  try { entries = await readdir(stateRoot, { withFileTypes: true }); } catch { return { error: 'no state directory at ' + stateRoot }; }
  const fields = new Map();
  const sizes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const team = await readTeam(stateRoot, entry.name).catch(() => undefined);
    if (team === undefined) continue;
    for (const recipient of ['captain', ...(team.members ?? []).map(m => m.name)]) {
      for (const message of await readMailbox(stateRoot, team.id, recipient).catch(() => [])) {
        const decoded = decodeMessage(message.content ?? '');
        if (decoded?.type !== type) continue;
        sizes.push(Buffer.byteLength(String(message.content ?? ''), 'utf8'));
        for (const [key, value] of Object.entries(decoded.body ?? {})) {
          fields.set(key, (fields.get(key) ?? 0) + Buffer.byteLength(JSON.stringify(value), 'utf8'));
        }
      }
    }
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  sizes.sort((a, b) => a - b);
  return { type, count: sizes.length, total, median: sizes[Math.floor(sizes.length / 2)] ?? 0, max: sizes.at(-1) ?? 0,
    byField: [...fields.entries()].sort((a, b) => b[1] - a[1]) };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('mail-volume-report.mjs')) {
  const workspace = process.argv[2];
  if (workspace === undefined) { console.error('usage: node scripts/mail-volume-report.mjs <workspace> [--state-dir .pair-programming]'); process.exit(2); }
  const flag = process.argv.indexOf('--state-dir');
  const stateDir = flag === -1 ? '.pair-programming' : process.argv[flag + 1];
  const dissectAt = process.argv.indexOf('--dissect');
  if (dissectAt !== -1) {
    const shape = await dissect(workspace, stateDir, process.argv[dissectAt + 1] ?? 'ARBITRATE');
    if (shape.error !== undefined) { console.error(shape.error); process.exit(2); }
    console.log(shape.type + ' letters: ' + shape.count + ', total ' + kb(shape.total) + 'K, median ' + kb(shape.median) + 'K, max ' + kb(shape.max) + 'K');
    for (const [key, bytes] of shape.byField) console.log('  ' + key.padEnd(18) + kb(bytes) + 'K  ' + Math.round(100 * bytes / Math.max(1, shape.total)) + '%');
    process.exit(0);
  }
  const { rows, totals, bySender, byType, top, error } = await mailVolumeReport(workspace, stateDir);
  if (error !== undefined) { console.error(error); process.exit(2); }
  const width = Math.max(6, ...rows.map(r => r.team.length));
  console.log('team'.padEnd(width) + '  recipient   msgs  selected     mail    prompt      owed  overhead');
  for (const r of rows) {
    console.log(r.team.padEnd(width) + '  ' + r.recipient.padEnd(10) + String(r.messages).padStart(5) + String(r.selected).padStart(10)
      + String(kb(r.mail) + 'K').padStart(9) + String(kb(r.prompt) + 'K').padStart(10) + String(kb(r.owed) + 'K').padStart(10) + String(kb(r.overhead) + 'K').padStart(10));
  }
  console.log('');
  console.log('TOTAL durable mail: ' + totals.messages + ' message(s), ' + kb(totals.mail) + 'K');
  console.log('ONE delivery per recipient: ' + kb(totals.prompt) + 'K on the wire, carrying ' + kb(totals.selectedMail) + 'K of message bytes');
  console.log('the owed-call segment of that footer is ' + kb(totals.owed) + 'K');
  console.log('a delivery is SMALLER than the batch it covers whenever an oversized record becomes a reference (see the per-row note)');
  console.log('backlog vs wire: the wire is capped at 8 logical messages per delivery, so ' + kb(totals.mail) + 'K of durable mail is delivered ' + kb(totals.prompt) + 'K at a time');
  console.log('');
  console.log('THE BACKLOG BY SENDER (top 8):');
  for (const [who, value] of (bySender ?? []).slice(0, 8)) console.log('  ' + who.padEnd(18) + kb(value) + 'K');
  console.log('THE BACKLOG BY MESSAGE TYPE (top 8):');
  for (const [what, value] of (byType ?? []).slice(0, 8)) console.log('  ' + what.padEnd(18) + kb(value) + 'K');
  console.log('THE LARGEST SINGLE MESSAGES:');
  for (const item of top ?? []) console.log('  ' + kb(item.bytes) + 'K  ' + item.team + '/' + item.recipient + '  from ' + item.from + '  type ' + item.type);
}