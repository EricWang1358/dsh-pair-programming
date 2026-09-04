/**
 * The CE provider against the REAL skill registry.
 *
 * Why this file exists. Every other CE test calls `makeCeProvider(...)` and
 * inspects what comes back — and every one of them passed while the provider
 * was unusable in a live session, because `list()` returned candidates with no
 * `provider` field. `dsh-skill` validates each candidate and requires
 * `provider` to be a string equal to the registering provider's own name; the
 * first real catalog fetch therefore threw
 *
 *   skill provider "pair-ce" returned skill "ce-code-review" with a non-string provider
 *
 * and the whole CE catalog was dead from V5.3b until a user hit it. A test that
 * calls our own object can never see this: the registry is the only thing that
 * checks. So this suite mounts the real `SkillRegistry` on a real Cordis
 * context and drives the same path a session does.
 *
 * The rule it encodes: when a contract belongs to the host, test through the
 * host. This is the second time in this integration that a green unit test sat
 * on top of a dead composition — the persona push was the first.
 */
import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import { makeCeProvider, installCeProvider, CE_PROVIDER_NAME } from '../lib/integrations/ce-provider.js';
import { CE_ALLOWLIST, CE_REVIEWED_SKILL_COUNT } from '../lib/integrations/ce-catalog.js';

const PROBE = { status: 'found', path: '/ce', version: '3.24.0', commitSha: 'abc1234' };

const io = {
  readFile: async () => ['---', 'name: whatever', 'description: CE own text', '---', '', 'Skill body here.'].join('\n'),
};

async function mount({ lane = 'advisory', soloLane = 'off', teamLive = true, override } = {}) {
  const ctx = new Context();
  ctx.plugin(SkillRegistry);
  await new Promise(resolve => setTimeout(resolve, 20));
  const provider = override ?? makeCeProvider({
    state: () => ({ lane, soloLane, probe: PROBE }),
    laneOf: async () => teamLive,
    io,
  });
  const handle = installCeProvider(ctx, { provider });
  return { ctx, handle };
}

async function fails(run) {
  try { await run(); return ''; } catch (error) { return String(error?.message ?? error); }
}

export async function run(check) {
  /* ---- the catalog the registry actually accepts ----------------------- */
  const paired = await mount({ lane: 'advisory', teamLive: true });
  const list = await paired.ctx.skills.list({ cwd: '/repo' });
  check(list.length === CE_ALLOWLIST.length, 'the real registry accepts every advisory candidate — the check that was missing');
  check(list.every(skill => skill.provider === CE_PROVIDER_NAME), 'and stamps each one with this provider');
  check(list.filter(skill => skill.invocation.modelInvocable).length === 7, 'seven analytical skills reach a model catalog');
  check(list.filter(skill => !skill.invocation.modelInvocable).length === 5, 'and five constructive ones never do — the host predicate, not our claim');

  const definition = await paired.ctx.skills.get('ce-code-review', { cwd: '/repo' });
  check(definition !== undefined, 'loading through the registry returns a body');
  check(definition.content.includes('BOUNDARY'), 'with the ownership boundary the pair lane requires');
  check(definition.content.includes('Skill body here.'), 'and the CE text itself');
  check(!definition.content.includes('description: CE own text'), 'frontmatter stripped');
  check(definition.provider === CE_PROVIDER_NAME && typeof definition.source === 'string', 'and a definition the registry validated end to end');

  /* ---- the regression, stated as the registry states it ---------------- */
  const bad = await mount({
    override: {
      name: CE_PROVIDER_NAME,
      // Exactly the shape that shipped: everything right except `provider`.
      list: async () => [{
        name: 'ce-code-review', description: 'x',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'custom', rank: 700, locator: {}, path: '/ce/x/SKILL.md',
      }],
      get: async () => undefined,
    },
  });
  const message = await fails(() => bad.ctx.skills.list({ cwd: '/repo' }));
  check(message.includes('non-string provider'), 'a candidate without `provider` is refused by the registry, with the exact message the live session reported');
  check(message.includes(CE_PROVIDER_NAME), 'and the refusal names the provider that produced it');

  /* ---- the same provider, the other lane -------------------------------- */
  const solo = await mount({ lane: 'advisory', soloLane: 'full', teamLive: false });
  const wide = await solo.ctx.skills.list({ cwd: '/repo' });
  check(wide.length === CE_REVIEWED_SKILL_COUNT, 'with no team live the registry accepts the whole solo set');
  check(wide.some(skill => skill.name === 'ce-work'), 'including the execution skills');
  const soloBody = await solo.ctx.skills.get('ce-work', { cwd: '/repo' });
  check(soloBody !== undefined && !soloBody.content.includes('BOUNDARY'), 'and serves them without a pair-protocol boundary that would not be true there');

  /* ---- withdrawal is real ---------------------------------------------- */
  paired.handle.dispose();
  check((await paired.ctx.skills.list({ cwd: '/repo' })).length === 0, 'disposing the registration removes every CE skill from the catalog');
}
