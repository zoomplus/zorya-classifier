import { z } from 'zod'
import { parse } from '../entities/contracts.js'
import { ClassifierError } from '../entities/errors.js'
import type { ObjectProposalPort } from '../entities/object-proposals.js'
import type { SegmentationPort } from '../entities/segmentation.js'
import type { ClassifierOptions } from './classifier-contracts.js'

const configSchema = z.object({
  timeoutMs: z.number().int().min(1).max(120000).default(45000),
  concurrency: z.number().int().min(1).max(4).default(2),
  maxQueue: z.number().int().min(0).max(32).default(16),
  maxInputBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024 * 1024)
    .default(64 * 1024 * 1024),
})

export type ClassifierRuntimeConfig = z.infer<typeof configSchema>

type ValidatedClassifierPorts = {
  segmenter: SegmentationPort | undefined
  objectProposals: ObjectProposalPort | undefined
}

export function validateClassifierOptions(options: ClassifierOptions): {
  config: ClassifierRuntimeConfig
  ports: ValidatedClassifierPorts
} {
  if (!options || typeof options.decision?.decide !== 'function')
    throw new ClassifierError('INVALID_INPUT', 'A DecisionPort is required')
  const segmenter = options.segmentation
  const objectProposals = options.objectProposals
  if (
    segmenter !== undefined &&
    (!segmenter ||
      typeof segmenter.segment !== 'function' ||
      (segmenter.expand !== undefined && typeof segmenter.expand !== 'function') ||
      typeof segmenter.settle !== 'function' ||
      typeof segmenter.dispose !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'segmentation must implement SegmentationPort')
  if (
    options.segmentationBoxCheck !== undefined &&
    (!options.segmentationBoxCheck || typeof options.segmentationBoxCheck.check !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'segmentationBoxCheck must implement its check port')
  if (
    objectProposals !== undefined &&
    (!objectProposals ||
      typeof objectProposals.propose !== 'function' ||
      typeof objectProposals.settle !== 'function' ||
      typeof objectProposals.dispose !== 'function')
  )
    throw new ClassifierError('INVALID_INPUT', 'objectProposals must implement ObjectProposalPort')
  const config = parse(configSchema, {
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    maxQueue: options.maxQueue,
    maxInputBytes: options.maxInputBytes,
  })
  return {
    config,
    ports: { segmenter, objectProposals },
  }
}
