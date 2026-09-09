/**
 * Goal-to-board coverage. The goal is an epic; these use cases are the
 * observable contract that must be allocated to task cards before coding.
 *
 * Pure logic, so the lifecycle, planner and terminal gate share one answer.
 */

import { attachUseCaseDesign, collaborationProblems } from './design.js';

const clean = (value) => String(value ?? '').trim();

/** Validate and assign stable ids to the use cases supplied at pair_start. */
export function normalizeUseCases(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('pair_start requires use_cases: enumerate every independently observable requirement before forming the team; an unlisted feature cannot be traced, tested, or completed');
  }
  const cases = input.map((raw, index) => {
    const actor = clean(raw?.actor);
    const intent = clean(raw?.intent);
    const outcome = clean(raw?.outcome);
    const criteria = Array.isArray(raw?.acceptance_criteria)
      ? raw.acceptance_criteria.map(clean).filter(Boolean)
      : [];
    const label = `UC-${index + 1}`;
    const problems = [];
    if (actor === '') problems.push('actor');
    if (intent === '') problems.push('intent');
    if (outcome === '') problems.push('outcome');
    if (criteria.length === 0) problems.push('acceptance_criteria');
    if (problems.length > 0) {
      throw new Error(`${label} is incomplete: ${problems.join(', ')} must be non-empty`);
    }
    return {
      id: label,
      actor,
      intent,
      outcome,
      acceptanceCriteria: criteria.map((text, criterionIndex) => ({
        id: `${label}.AC-${criterionIndex + 1}`,
        text,
      })),
    };
  });
  return attachUseCaseDesign(cases, input);
}

/** Flatten all epic acceptance ids in declaration order. */
export function allAcceptanceRefs(team) {
  return (team?.useCases ?? []).flatMap(useCase =>
    (useCase.acceptanceCriteria ?? []).map(criterion => criterion.id));
}

/** Validate task allocation refs against the epic contract. */
export function allocationProblems(team, refs) {
  const wanted = Array.isArray(refs) ? refs.map(clean).filter(Boolean) : [];
  const known = new Set(allAcceptanceRefs(team));
  if (known.size === 0) return [];
  if (wanted.length === 0) return ['acceptance_refs: assign at least one goal acceptance criterion to this task'];
  const unknown = wanted.filter(ref => !known.has(ref));
  const duplicates = wanted.filter((ref, index) => wanted.indexOf(ref) !== index);
  return [
    ...(unknown.length > 0 ? [`acceptance_refs: unknown ${[...new Set(unknown)].join(', ')}`] : []),
    ...(duplicates.length > 0 ? [`acceptance_refs: duplicate ${[...new Set(duplicates)].join(', ')}`] : []),
  ];
}

/** One canonical coverage view for status, planning, gates and completion. */
export function goalCoverage(team) {
  const all = allAcceptanceRefs(team);
  const rows = all.map(ref => {
    const tasks = (team?.tasks ?? []).filter(task => (task.acceptanceRefs ?? []).includes(ref));
    const completed = tasks.filter(task => task.status === 'completed');
    const oracle = tasks.filter(task => (task.oracle?.caseRefs ?? []).includes(ref));
    return {
      ref,
      tasks: tasks.map(task => task.id),
      completed: completed.map(task => task.id),
      oracle: oracle.map(task => task.id),
    };
  });
  return {
    total: all.length,
    allocated: rows.filter(row => row.tasks.length > 0).length,
    verified: rows.filter(row => row.oracle.length > 0).length,
    completed: rows.filter(row => row.completed.length > 0).length,
    missingAllocation: rows.filter(row => row.tasks.length === 0).map(row => row.ref),
    missingOracle: rows.filter(row => row.tasks.length > 0 && row.oracle.length === 0).map(row => row.ref),
    incomplete: rows.filter(row => row.completed.length === 0).map(row => row.ref),
    rows,
  };
}

/** Every goal criterion must be on the board before implementation starts. */
export function planningCoverageError(team) {
  const designErrors = collaborationProblems(team);
  if (designErrors.length) return `DESIGN_NOT_READY: ${designErrors.join("; ")}`;
  const coverage = goalCoverage(team);
  if (coverage.total === 0) return undefined; // archived pre-coverage teams remain readable/operable
  if (coverage.missingAllocation.length === 0) return undefined;
  return `SCOPE_NOT_FROZEN: goal acceptance criteria are still absent from the task board: ${coverage.missingAllocation.join(', ')}. Create/adjust task cards with acceptance_refs before opening the first cycle.`;
}

/** Validate the executable case map supplied by the SPEC author. */
export function oracleCoverageProblems(task, refs) {
  const assigned = task?.acceptanceRefs ?? [];
  if (assigned.length === 0) return [];
  const covered = Array.isArray(refs) ? refs.map(clean).filter(Boolean) : [];
  const missing = assigned.filter(ref => !covered.includes(ref));
  const extra = covered.filter(ref => !assigned.includes(ref));
  return [
    ...(missing.length > 0 ? [`case_refs: no executable oracle case traces ${missing.join(', ')}`] : []),
    ...(extra.length > 0 ? [`case_refs: ${extra.join(', ')} are not allocated to task ${task.id}`] : []),
  ];
}
