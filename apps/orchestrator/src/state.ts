export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

export function isStateIn(state: string, states: string[]): boolean {
  const normalized = normalizeState(state);
  return states.some((candidate) => normalizeState(candidate) === normalized);
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}
