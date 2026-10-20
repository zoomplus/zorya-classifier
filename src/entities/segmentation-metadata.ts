/** Diagnostic native scores are uncalibrated finite values, not probabilities. */
export interface SegmentationMetadata {
  method: string
  backend: string
  durationMs: number
  input: { width: number; height: number }
  qualityScore?: number
}
