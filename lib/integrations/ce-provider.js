/**
 * The CE skill provider: this plugin serves a curated slice of a detected
 * Compound Engineering checkout, instead of pointing a filesystem provider at
 * CE's `skills/` directory.
 *
 * Why own the provider rather than configure someone else's. Adding CE's
 * `skills/` to `dsh-skill-filesystem`'s `customSkillDirs` is one line and three
 * problems: it is another plugin's configuration surface, so this plugin could
 * neither gate it on protocol state nor withdraw it; it exposes all 33 skills
 * including `ce-work` and `lfg`, which own their own execution loop and would
 * put a second write scheduler behind the same worktree; and it forwards CE's
 * own frontmatter descriptions into a catalog that is billed on every step.
 *
 * Owning the provider buys four things: a closed allowlist, a rank that can
 * never shadow a local skill, descriptions we author, and one observation
 * point — `get()` is our code, so V5.3d can record every load on the board.
 *
 * What it cannot buy: per-role filtering. `SkillProvider.list/get` receive
 * `{ cwd, signal }` and no caller identity, and the registry's scope layers
 * belong to agent-preset compositions rather than to members spawned through
 * `startContinuable`. Role separation therefore lives at the two places that
 * do have identity — the member `toolFilter`, and the gate reading the load
 * record — never here.
 *
 * @module dsh-pair-programming/integrations/ce-provider
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CE_SKILL_RANK, entriesFor } from './ce-catalog.js';

/** Provider name in the `ctx.skills` registry. */
export const CE_PROVIDER_NAME = 'pair-ce';

const defaultIo = { readFile: (path) => readFile(path, 'utf8') };

/** Strip a leading YAML frontmatter block; CE bodies carry one. */
export function stripFrontmatter(text) {
  const body = String(text ?? '');
  if (!body.startsWith('---')) return body.trim();
  const end = body.indexOf('\n---', 3);
  if (end === -1) return body.trim();
  const after = body.indexOf('\n', end + 1);
  return after === -1 ? '' : body.slice(after + 1).trim();
}

/**
 * The ownership statement prepended to every CE body this plugin serves.
 *
 * It is not a substitute for enforcement — the write-lane skills are simply
 * absent from the catalog, and V5.3d refuses a receipt if one is loaded from
 * anywhere else. It exists because a seat reading CE's own instructions is
 * reading text written for a different protocol, one where the same agent
 * plans, edits, commits and opens the PR. Saying whose worktree this is costs
 * a few dozen tokens and removes the most likely misread.
 */
export function boundaryPreamble(name) {
  return [
    `<!-- served by dsh-pair-programming from a local Compound Engineering checkout: ${name} -->`,
    'BOUNDARY (this host, not the skill\'s own assumptions):',
    '- This skill is ADVISORY here. The pair protocol owns every write to product code: the Driver is the sole writer, and changes happen through the Pair Cycle (pair_propose -> pair_red/pair_green -> pair_verify).',
    '- Do not run this skill\'s own execution, commit, worktree, PR or shipping steps. If it tells you to implement, commit, push, or open a PR, stop and report instead.',
    '- Return what you found through the pair tools: findings become review notes, risks become pair_risk_raise, and anything you noticed beyond the request is a disclosure, not a silent fix.',
    '- The acceptance oracle is frozen and sealed. Nothing in this skill may re-derive, widen, or edit it.',
    '',
    '--- skill content follows ---',
    '',
  ].join('\n');
}

/**
 * Resolve which lane one workspace is in.
 *
 * A workspace with a live pair team gets the narrow lane; everything else gets
 * the solo lane. The answer is cached briefly because `list()` runs on every
 * catalog refresh and the question costs a directory read — and because the
 * answer changing mid-cycle is not something a few seconds of staleness can
 * make worse: `pair_start` and `pair_stop` both invalidate the catalog anyway.
 */
export function makeLaneResolver(deps) {
  const ttl = deps.ttlMs ?? 5_000;
  const cache = new Map(); // cwd -> { at, teamLive }
  return async (cwd, opts = {}) => {
    const key = String(cwd ?? '');
    if (key === '') return false;
    const hit = cache.get(key);
    const now = deps.now?.() ?? Date.now();
    // `get()` reads through: a team that went live inside the TTL would
    // otherwise be served a solo body — the one staleness that matters, since
    // it is the body that carries (or fails to carry) the ownership boundary.
    if (opts.fresh !== true && hit !== undefined && now - hit.at < ttl) return hit.teamLive;
    let teamLive = false;
    try {
      teamLive = await deps.teamLive(key);
    } catch {
      // An unreadable state directory must not silently widen the lane: while
      // we cannot tell, assume a team is live and serve the narrow set.
      teamLive = true;
    }
    cache.set(key, { at: now, teamLive });
    return teamLive;
  };
}

/**
 * Decide which lane one call is in.
 *
 * An explicit `options.teamLive` wins outright. That is not a convenience: the
 * persona push calls this provider directly rather than through the registry,
 * it happens by construction inside a live team, and it has no session cwd to
 * offer. Without the override it resolved to "no team", served the solo set,
 * and pushed a body with no ownership boundary into a live team's seat — the
 * exact misread the boundary exists to prevent.
 */
async function resolveTeamLive(laneOf, options, opts = {}) {
  if (typeof options?.teamLive === 'boolean') return options.teamLive;
  return laneOf(options?.cwd, opts);
}

/** Invocation policy for one allowlist row. */
export function invocationFor(entry) {
  return entry.surface === 'user'
    // Never in a model catalog: zero repeated tokens, reachable only when a
    // human types `/<name>`. Open-ended constructive work belongs here.
    ? { modelInvocable: false, userInvocable: true }
    : { modelInvocable: true, userInvocable: true };
}

/**
 * Build the provider object.
 *
 * @param {{ state: () => ({lane:string, probe:object|undefined}), io?:object, onLoad?:Function }} deps
 *   `state()` is read on every call so a settings change takes effect on the
 *   next catalog fetch rather than at registration time.
 */
export function makeCeProvider(deps) {
  const io = deps.io ?? defaultIo;
  const laneOf = deps.laneOf ?? (async () => true);
  return {
    name: CE_PROVIDER_NAME,
    async list(options) {
      const { lane, soloLane, probe } = deps.state();
      if (probe?.status !== 'found') return [];
      const root = probe.path;
      const teamLive = await resolveTeamLive(laneOf, options);
      return entriesFor({ lane, soloLane, teamLive }).map(entry => ({
        name: entry.name,
        description: entry.description,
        invocation: invocationFor(entry),
        source: 'custom',
        // The registry validates every candidate and requires `provider` to be
        // a string equal to this provider's own name (dsh-skill validateCandidate).
        // Omitting it made EVERY listed candidate invalid, which no test that
        // called this provider directly could see — the registry is the only
        // thing that checks.
        provider: CE_PROVIDER_NAME,
        rank: CE_SKILL_RANK,
        locator: { name: entry.name, dir: join(root, 'skills', entry.name) },
        path: join(root, 'skills', entry.name, 'SKILL.md'),
        resourceBase: { kind: 'directory', path: join(root, 'skills', entry.name) },
        metadata: { ceVersion: probe.version, ceCommit: probe.commitSha, surface: entry.surface },
      }));
    },
    async get(candidate, options) {
      const { lane, soloLane, probe } = deps.state();
      // Re-check on load: a lane switched off, a team that went live between
      // catalog and load, or a checkout that moved, must not still serve a body.
      if (probe?.status !== 'found') return undefined;
      const teamLive = await resolveTeamLive(laneOf, options, { fresh: true });
      if (!entriesFor({ lane, soloLane, teamLive }).some(entry => entry.name === candidate.name)) return undefined;
      let raw;
      try {
        raw = await io.readFile(candidate.path);
      } catch {
        return undefined;
      }
      // The boundary statement is for pair mode. Outside a team CE legitimately
      // owns its own loop, and prefixing "the pair protocol owns every write"
      // onto a skill running in a session with no protocol would be a lie the
      // model then has to reconcile.
      const body = stripFrontmatter(raw);
      const content = teamLive ? `${boundaryPreamble(candidate.name)}${body}` : body;
      try {
        deps.onLoad?.({
          name: candidate.name, path: candidate.path, at: Date.now(),
          ceCommit: probe.commitSha, cwd: options?.cwd,
          lane: teamLive ? lane : soloLane, teamLive,
        });
      } catch { /* accounting must never break a load */ }
      return { ...candidate, content };
    },
  };
}

/**
 * Register the provider on a context that has `ctx.skills`.
 *
 * The provider is registered once, synchronously, and reports an empty catalog
 * whenever the lane is `off` or no checkout was detected. That is deliberately
 * NOT the same as "registered only when needed": `dsh-tool-skill` sends no
 * catalog tokens for an empty list, so the token cost of an idle provider is
 * zero, while a provider that appears and disappears would append a full
 * replacement catalog to every live session each time a user touched the knob.
 *
 * @returns {{ refresh: Function, dispose: Function }}
 */
export function installCeProvider(ctx, deps) {
  let control;
  const dispose = ctx.skills.registerProvider((registrationControl) => {
    control = registrationControl;
    // A caller that already built the provider passes it in, so the push path
    // and the pull path are served by ONE object: same allowlist check, same
    // boundary preamble, same ledger entry.
    return deps.provider ?? makeCeProvider(deps);
  });
  return {
    /** Tell the registry the catalog may have changed (lane switch, re-probe). */
    refresh: () => { try { control?.invalidate?.(); } catch { /* disposed */ } },
    dispose,
  };
}
