// Small formatting helpers shared across the playground UI.

export const uid = (): string => Math.random().toString(36).slice(2, 9);

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}
