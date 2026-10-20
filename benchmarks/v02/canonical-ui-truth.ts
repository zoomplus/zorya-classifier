import { z } from 'zod'

const caseId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u)
const dimension = z.number().int().positive().safe()
const coordinate = z.number().int().nonnegative().safe()
const coverage = z.number().finite().min(0).max(1)
const box = z.object({ x: coordinate, y: coordinate, width: dimension, height: dimension }).strict()
const sourceCommon = {
  id: caseId,
  action: z.string().min(1).max(512),
  oracle: z.string().min(1).max(4000),
  scope: z.string().min(1).max(4000),
}
const sourceRows = z
  .array(
    z.discriminatedUnion('kind', [
      z
        .object({
          ...sourceCommon,
          kind: z.literal('positive'),
          bbox: box,
          allocation: z.tuple([coordinate, coordinate, dimension, dimension]),
          paintEvidence: z
            .object({
              fourEdgeMagentaCoverage: z
                .object({ top: coverage, bottom: coverage, left: coverage, right: coverage })
                .strict(),
              innerGreenCoverage: coverage,
              passes: z.literal(true),
            })
            .strict(),
        })
        .passthrough(),
      z
        .object({
          ...sourceCommon,
          kind: z.literal('negative'),
          bbox: z.null(),
          negativeEvidence: z
            .object({
              completeATSPIPushToggleInventory: z.literal(true),
              inventorySha256: z.string().regex(/^[a-f0-9]{64}$/u),
              exactActionAbsent: z.literal(true),
            })
            .strict(),
        })
        .passthrough(),
    ]),
  )
  .min(1)
  .max(120)
const producerRows = z
  .array(
    z
      .object({
        caseId,
        image: z.object({ width: dimension, height: dimension }).passthrough(),
      })
      .passthrough(),
  )
  .min(1)
  .max(120)

/** Evaluator-only parsing; this module never opens a corpus file or dispatches a request. */
export function parseControlledUiTruthJsonl(text: string): unknown[] {
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024)
    throw new Error('Controlled UI oracle exceeds its byte limit')
  const body = text.replace(/\r?\n$/u, '')
  const lines = body.split(/\r?\n/u)
  if (!body || lines.length > 120 || lines.some((line) => !line.trim()))
    throw new Error('Controlled UI oracle has invalid record framing')
  return lines.map((line): unknown => JSON.parse(line))
}

/**
 * Convert independently captured UI oracles to the existing evaluator contract.
 * For a blind split, invoke only after the candidate recipe has been frozen.
 * Source labels and measured geometry are copied, never inferred from an ID/order.
 */
export function canonicalizeControlledUiTruth(sourceValue: unknown, producerValue: unknown) {
  const sources = sourceRows.parse(sourceValue)
  const producers = producerRows.parse(producerValue)
  const sourceById = new Map(sources.map((row) => [row.id, row]))
  const producerIds = new Set(producers.map((row) => row.caseId))
  if (
    sourceById.size !== sources.length ||
    producerIds.size !== producers.length ||
    sources.length !== producers.length ||
    sources.some((row) => !producerIds.has(row.id))
  )
    throw new Error('Controlled UI oracle and producer case identities differ')

  return producers.map((producer) => {
    const source = sourceById.get(producer.caseId)
    if (!source) throw new Error('Controlled UI oracle is missing a producer case')
    const provenance = {
      sourceRecordId: source.id,
      sourceOracle: source.oracle,
      scope: source.scope,
    }
    if (source.kind === 'negative')
      return {
        caseId: producer.caseId,
        expectedPresence: 'absent' as const,
        targetBoxes: [],
        negativeEvidence: { ...source.negativeEvidence, scope: source.scope },
        provenance,
      }

    const { x, y, width, height } = source.bbox
    if (
      x + width > producer.image.width ||
      y + height > producer.image.height ||
      source.allocation.some((value, index) => value !== [x, y, width, height][index]) ||
      Object.values(source.paintEvidence.fourEdgeMagentaCoverage).some((value) => value < 0.8)
    )
      throw new Error('Controlled UI positive geometry disagrees with its source oracle')
    return {
      caseId: producer.caseId,
      expectedPresence: 'present' as const,
      targetBoxes: [
        {
          xyxy: [
            x / producer.image.width,
            y / producer.image.height,
            (x + width) / producer.image.width,
            (y + height) / producer.image.height,
          ],
        },
      ],
      negativeEvidence: null,
      provenance,
    }
  })
}
