/** Frozen use-case decisions and collaboration contracts; no extra review loop. */
const text = value => typeof value === 'string' ? value.trim() : '';
function required(value, field) {
  const result = text(value);
  if (!result) throw new Error(`DESIGN_NOT_READY: ${field} must be nonblank`);
  return result;
}
function nonempty(value, field) {
  if (!Array.isArray(value) || !value.length || value.some(item => !text(item))) throw new Error(`DESIGN_NOT_READY: ${field} needs nonblank entries`);
  return value.map(text);
}
function decision(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`DESIGN_NOT_READY: ${label} needs a design object`);
  if (raw.open_questions !== undefined && (!Array.isArray(raw.open_questions) || raw.open_questions.length)) {
    throw new Error(`DESIGN_NOT_READY: resolve ${label}.open_questions before dispatch; use a bounded discovery/spike first`);
  }
  return {
    responsibility: required(raw.responsibility, `${label}.responsibility`),
    approach: required(raw.approach, `${label}.approach`),
    invariants: nonempty(raw.invariants, `${label}.invariants`),
    failureBehavior: required(raw.failure_behavior, `${label}.failure_behavior`),
    tradeoffs: required(raw.tradeoffs, `${label}.tradeoffs`),
    ...(raw.pattern === undefined ? {} : {
      pattern: required(raw.pattern, `${label}.pattern`),
      patternReason: required(raw.pattern_reason, `${label}.pattern_reason`),
    }),
  };
}

/** Preserve original AC ids, then append independently testable interaction cases. */
export function attachUseCaseDesign(cases, input) {
  for (const [index, useCase] of cases.entries()) {
    const raw = input[index];
    if (raw.design !== undefined) useCase.design = decision(raw.design, useCase.id);
    if (raw.interactions === undefined) continue;
    if (!Array.isArray(raw.interactions)) throw new Error(`DESIGN_NOT_READY: ${useCase.id}.interactions must be an array`);
    if (raw.interactions.length && !useCase.design) throw new Error(`DESIGN_NOT_READY: ${useCase.id} needs its local design before collaboration design`);
    useCase.interactions = raw.interactions.map((item, i) => {
      const id = `${useCase.id}.I-${i + 1}`;
      const design = decision(item, id);
      const target = required(item.target, `${id}.target`);
      if (target === useCase.id || !cases.some(candidate => candidate.id === target)) throw new Error(`DESIGN_NOT_READY: ${id} must target another declared use case`);
      const requires = nonempty(item.requires, `${id}.requires`);
      const criteria = nonempty(item.acceptance_criteria, `${id}.acceptance_criteria`);
      const acceptanceRefs = criteria.map(value => {
        const ref = `${useCase.id}.AC-${useCase.acceptanceCriteria.length + 1}`;
        useCase.acceptanceCriteria.push({ id: ref, text: value, interactionId: id });
        return ref;
      });
      return { id, target, requires: [...new Set(requires)], contract: required(item.contract, `${id}.contract`), ...design, acceptanceRefs };
    });
  }
  for (const useCase of cases) for (const interaction of useCase.interactions ?? []) {
    const target = cases.find(candidate => candidate.id === interaction.target);
    if (interaction.requires.some(ref => !target.acceptanceCriteria.some(criterion => criterion.id === ref))) {
      throw new Error(`DESIGN_NOT_READY: ${interaction.id}.requires must reference acceptance criteria of ${target.id}`);
    }
  }
  return cases;
}

/** One interaction owner; providers in the same slice or its dependency ancestry. */
export function collaborationProblems(team) {
  const tasks = team?.tasks ?? [];
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ancestors = task => {
    const found = new Set([task.id]);
    const visit = id => {
      if (found.has(id)) return;
      found.add(id);
      for (const next of byId.get(id)?.dependencies ?? []) visit(next);
    };
    for (const id of task.dependencies ?? []) visit(id);
    return tasks.filter(candidate => found.has(candidate.id));
  };
  const problems = [];
  for (const useCase of team?.useCases ?? []) for (const interaction of useCase.interactions ?? []) {
    const owners = tasks.filter(task => interaction.acceptanceRefs.some(ref => task?.acceptanceRefs?.includes(ref)));
    if (owners.length > 1) problems.push(`${interaction.id}: allocate the interaction to one accountable task`);
    for (const owner of owners) {
      if (!interaction.acceptanceRefs.every(ref => owner.acceptanceRefs?.includes(ref))) problems.push(`${interaction.id}: ${owner.id} must own all interaction cases`);
      const supplied = new Set(ancestors(owner).flatMap(task => task.acceptanceRefs ?? []));
      const missing = interaction.requires.filter(ref => !supplied.has(ref));
      if (missing.length) problems.push(`${interaction.id}: ${owner.id} needs ${missing.join(', ')} in the same task or a dependency; create the provider first or keep coupled work in one slice`);
    }
  }
  return problems;
}

/** Only the selected task's frozen decisions, never the whole team's history. */
export function taskDesignContext(team, task) {
  const owns = ref => task?.acceptanceRefs?.includes(ref);
  return (team?.useCases ?? []).flatMap(useCase => {
    const criteria = (useCase.acceptanceCriteria ?? []).filter(c => owns(c.id));
    const interactions = (useCase.interactions ?? []).filter(i => [...i.acceptanceRefs, ...i.requires].some(owns));
    const design = criteria.length ? useCase.design : undefined;
    return design || interactions.length ? [{ useCase: useCase.id, ...(design ? { design } : {}), criteria, interactions }] : [];
  });
}
