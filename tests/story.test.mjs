/** story layer: user-story shape + machine-checkable INVEST rules. */
import { validateStory, normalizeRole, isSynonymousRestatement } from '../lib/protocol/story.js';

export async function run(check) {
  // the course's two "hard review requirements" must fail closed...
  const generic = validateStory({
    subject: 'login', role: 'User', intent: 'sign in securely',
    benefit: 'so that I can access my account safely', acceptance_criteria: ['bad password rejected after 5 tries'],
  });
  check(generic.ok === false && generic.errors.some(e => e.includes('generalized')), 'INVEST: generic role "User" rejected');
  check(validateStory({ subject: 's', role: '用户', intent: '订机票', benefit: '快速完成预订', acceptance_criteria: ['x'] }).errors.some(e => e.includes('generalized')), 'INVEST: Chinese generic role rejected');

  const synonym = validateStory({
    subject: 'profile', role: 'job seeker', intent: 'update my profile',
    benefit: 'modify my profile', acceptance_criteria: ['changes persist'],
  });
  check(synonym.ok === false && synonym.errors.some(e => e.includes('synonymous')), 'INVEST: benefit restating goal rejected');

  const noAC = validateStory({
    subject: 'receipt', role: 'customer', intent: 'download my receipt',
    benefit: 'reimburse my travel expenses', acceptance_criteria: [],
  });
  check(noAC.ok === false && noAC.errors.some(e => e.includes('Testable')), 'INVEST: missing acceptance criteria rejected');

  const noBenefit = validateStory({ subject: 'x', role: 'admin', intent: 'see audit logs', acceptance_criteria: ['logs shown'] });
  check(noBenefit.ok === false && noBenefit.errors.some(e => e.includes('benefit')), 'INVEST: missing benefit rejected');

  // ...and the correctly-captured story must pass.
  const good = validateStory({
    subject: 'profile', role: 'job seeker', intent: 'update my profile',
    benefit: 'improve my visibility to employers and get more interviews',
    acceptance_criteria: ['edits saved within 2s', 'employer search index refreshed'],
  });
  check(good.ok === true, 'INVEST: well-formed story passes');

  const cjkGood = validateStory({
    subject: '退票', role: '客服专员', intent: '一键发起退票', benefit: '减少旅客电话排队等待时间',
    acceptance_criteria: ['退票成功返回单号'],
  });
  check(cjkGood.ok === true, 'INVEST: CJK story passes');
  const cjkSyn = validateStory({
    subject: '退票', role: '客服专员', intent: '发起退票流程', benefit: '完成退票流程',
    acceptance_criteria: ['x'],
  });
  check(cjkSyn.errors.some(e => e.includes('synonymous')), 'INVEST: CJK synonym restatement rejected');

  // helpers
  check(normalizeRole('As a travel agent') === 'travel agent', 'role prefix stripped');
  check(normalizeRole('作为一个乘客') === '乘客', 'CJK role prefix stripped');
  check(isSynonymousRestatement('submit the order', 'submit the order online') === true, 'synonym: subset caught');
  check(isSynonymousRestatement('compare flight prices', 'improve conversion on bookings') === false, 'synonym: distinct value passes');
}
