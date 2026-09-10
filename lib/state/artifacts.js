/** Stable per-run artifact identity; absent on legacy boards whose paths must not move. */
export function oracleDirectory(team) {
  const key = team?.artifactNamespace;
  if (key === undefined) return '.pair-oracles';
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error('Invalid artifact namespace');
  return '.pair-oracles/' + key;
}
export function scratchDirectory(team) {
  oracleDirectory(team); // Validate the same durable namespace at every path boundary.
  return '.pair-work/' + (team.artifactNamespace ?? team.id);
}
