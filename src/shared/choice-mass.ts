/** Checks wire consistency, not informativeness or calibrated confidence. */
export function acceptsChoiceMass(scores: readonly number[], step?: 0.01): boolean {
  if (scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)) return false
  const mass = scores.reduce((sum, score) => sum + score, 0)
  if (Math.abs(mass - 1) <= 1e-6) return true
  if (step !== 0.01) return false
  let lower = 0
  let upper = 0
  for (const score of scores) {
    if (Math.abs(score - Math.round(score / step) * step) > 1e-12) return false
    lower += Math.max(0, score - step / 2)
    upper += Math.min(1, score + step / 2)
  }
  return lower <= 1 + 1e-12 && upper >= 1 - 1e-12
}
