import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DecisionMetadata,
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterImage,
  RasterPort,
} from '../src/entities/contracts.js'
import type { CutoutRasterPort } from '../src/entities/cutout-raster.js'
import type {
  ObjectProposalBatch,
  ObjectProposalInput,
  ObjectProposalPort,
  ObjectProposalPresentationPort,
} from '../src/entities/object-proposals.js'
import type { RgbaRaster } from '../src/entities/representation.js'
import type { WholeObjectLocateInput } from '../src/entities/whole-object.js'
import { ClassifierError } from '../src/entities/errors.js'
import { locateFromProposals } from '../src/processes/proposal-location.js'

const metadata: DecisionMetadata = {
  model: 'fixture-model',
  provider: 'fixture-provider',
  requestId: 'fixture-request',
  durationMs: 1,
  costUsd: 0.001,
  attempts: 1,
}
const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function choiceResult(
  question: DecisionRequest['questions'][string],
  answer: string,
): DecisionResult {
  assert.ok(question)
  if (question.type !== 'choice') throw new Error('fixture expected Choice')
  const keys = Object.keys(question.criteria)
  const probabilities = Object.fromEntries(keys.map((key) => [key, key === answer ? 1 : 0]))
  return {
    answers: { selection: { type: 'choice', choice: answer, probabilities } },
    metadata,
  }
}

function seedResult(request: DecisionRequest, absent = false): DecisionResult {
  const question = request.questions['selection']
  assert.ok(question && question.type === 'choice')
  const keys = Object.keys(question.criteria)
  const answer = question.rankingSize === 1 ? keys[0]! : keys.slice(0, Math.min(4, keys.length))
  return {
    answers: {
      selection: { type: 'ranked-choice', ranking: Array.isArray(answer) ? answer : [answer] },
      presence: { type: 'noul', noul: absent ? 0 : 1 },
    },
    metadata,
  }
}

function fullMask(width = 8, height = 8): Uint8Array {
  return new Uint8Array(Math.ceil((width * height) / 8)).fill(0xff)
}

function rectMask(left: number, top: number, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(8)
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const index = y * 8 + x
      mask[index >>> 3] = (mask[index >>> 3] ?? 0) | (1 << (index & 7))
    }
  }
  return mask
}

function setPackedPixel(mask: Uint8Array, x: number, y: number): void {
  const index = y * 8 + x
  mask[index >>> 3] = (mask[index >>> 3] ?? 0) | (1 << (index & 7))
}

function clearPackedPixel(mask: Uint8Array, x: number, y: number): void {
  const index = y * 8 + x
  mask[index >>> 3] = (mask[index >>> 3] ?? 0) & ~(1 << (index & 7))
}

function baseBatch(overrides: Partial<ObjectProposalBatch> = {}): ObjectProposalBatch {
  return {
    proposals: [
      {
        id: 'C00',
        mask: { data: rectMask(2, 2, 4, 4), width: 8, height: 8, format: 'binary-lsb0' },
        qualityScore: 0.13,
      },
    ],
    metadata: {
      method: 'fixture-proposals',
      backend: 'private-backend-name',
      durationMs: 4,
      input: { width: 8, height: 8 },
      qualityScore: 0.42,
    },
    ...overrides,
  }
}

function harness(
  options: {
    batch?: ObjectProposalBatch
    batchFactory?: (input: ObjectProposalInput) => ObjectProposalBatch
    seedAbsent?: boolean
    selection?: string
    wholeScore?: number
    width?: number
    height?: number
    roi?: { left: number; top: number; width: number; height: number }
    abortDuringPresentation?: boolean
    abortDuringFocusedPresentation?: boolean
    transparentSource?: boolean
  } = {},
) {
  const width = options.width ?? 8
  const height = options.height ?? 8
  const controller = new AbortController()
  const signal = controller.signal
  const requests: DecisionRequest[] = []
  const presentationCalls: Array<{
    ids: string[]
    regions: Array<{ left: number; top: number; width: number; height: number } | null>
  }> = []
  const seenSignals: AbortSignal[] = []
  let proposalInput: ObjectProposalInput | undefined
  let presentedImage: RgbaRaster | undefined
  let presentedRegion:
    | { left: number; top: number; width: number; height: number }
    | null
    | undefined
  let settled = 0
  const raster: RasterPort = {
    async normalize(bytes, callSignal): Promise<RasterImage> {
      seenSignals.push(callSignal)
      return { bytes: new Uint8Array(bytes), width, height }
    },
    async crop(image, region, callSignal) {
      seenSignals.push(callSignal)
      return {
        bytes: new Uint8Array([1]),
        width: region.width,
        height: region.height,
      }
    },
    async imageState(_image, callSignal) {
      seenSignals.push(callSignal)
      return ['[fixture image]']
    },
    async grid(_image, _region, _cells, _labels, callSignal) {
      seenSignals.push(callSignal)
      return { bytes: new Uint8Array([1]), width, height }
    },
  }
  const decision: DecisionPort = {
    async decide(request, callSignal) {
      requests.push(request)
      seenSignals.push(callSignal)
      if (request.questions['selection'] && request.questions['presence'])
        return seedResult(request, options.seedAbsent)
      if (request.questions['selection']) {
        const question = request.questions['selection']!
        const answer =
          options.selection ??
          (question.type === 'choice' && question.criteria['C00'] ? 'C00' : 'A')
        return choiceResult(question, answer)
      }
      if (request.questions['presence'])
        return {
          answers: { presence: { type: 'noul', noul: options.wholeScore ?? 0.8 } },
          metadata,
        }
      throw new Error('Unexpected request')
    },
  }
  const image: CutoutRasterPort = {
    async rgba(_normalized, callSignal) {
      seenSignals.push(callSignal)
      const data = new Uint8Array(width * height * 4).fill(7)
      if (options.transparentSource)
        for (let index = 3; index < data.length; index += 4) data[index] = 0
      return {
        data,
        width,
        height,
        format: 'rgba8',
      }
    },
    async png(_rgba, callSignal) {
      seenSignals.push(callSignal)
      return pngHeader
    },
  }
  const proposals: ObjectProposalPort = {
    async propose(input) {
      proposalInput = input
      seenSignals.push(input.signal)
      // A hostile port may mutate its private copy, but never the process-owned snapshot.
      input.image.data.fill(99)
      return options.batchFactory?.(input) ?? options.batch ?? baseBatch()
    },
    async settle() {
      settled += 1
    },
    async dispose() {},
  }
  const presentation: ObjectProposalPresentationPort = {
    async render(input) {
      seenSignals.push(input.signal)
      presentationCalls.push({
        ids: input.proposals.map((proposal) => proposal.id),
        regions: input.proposals.map((proposal) => proposal.region),
      })
      presentedImage = input.image
      assert.ok(input.proposals.length >= 1)
      presentedRegion = input.proposals[0]?.region
      input.image.data.fill(88)
      input.proposals[0]!.mask.data.fill(0)
      if (
        options.abortDuringPresentation ||
        (options.abortDuringFocusedPresentation && presentationCalls.length === 2)
      )
        controller.abort(new ClassifierError('ABORTED', 'fixture abort'))
      return [0, 1, 2, 3].map(() => new Uint8Array(pngHeader))
    },
  }
  const input: Omit<WholeObjectLocateInput, 'signal'> = {
    image: new Uint8Array([1]),
    target: 'small red car',
    exclusions: [],
    roi: options.roi ?? { left: 2, top: 2, width: 4, height: 4 },
    mode: 'whole-object',
  }
  return {
    signal,
    abort: () => controller.abort(new ClassifierError('ABORTED', 'fixture abort')),
    requests,
    presentationCalls,
    seenSignals,
    get proposalInput() {
      return proposalInput
    },
    get presentedImage() {
      return presentedImage
    },
    get presentedRegion() {
      return presentedRegion
    },
    get settled() {
      return settled
    },
    dependencies: { decision, raster, image, proposals, presentation },
    input,
  }
}

await test('proposal localization returns exact packed-mask bounds and sends only closed aliases', async () => {
  const h = harness()
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'located')
  if (result.location.status !== 'located') return
  assert.equal(result.location.method, 'pixel-mask-proposals-v1')
  assert.deepEqual(result.location.region, { left: 2, top: 2, width: 4, height: 4 })
  assert.equal(result.location.completeness, 'boundary-limited')
  assert.deepEqual(result.location.bounds, {
    left: { start: 2, endExclusive: 3 },
    right: { start: 5, endExclusive: 6 },
    top: { start: 2, endExclusive: 3 },
    bottom: { start: 5, endExclusive: 6 },
  })
  assert.ok(result.mask)
  assert.equal(
    result.mask.data.reduce((sum, bit) => sum + bit, 0),
    16,
  )
  assert.equal(result.mask.data[0], 0)
  assert.equal(result.mask.data[2 * 8 + 2], 1)
  assert.equal(result.segmentation?.backend, 'private-backend-name')
  assert.equal(result.location.metadata.stages.length, 5)
  assert.equal(h.settled, 0)
  assert.ok(h.proposalInput)
  assert.equal(h.proposalInput?.signal, h.signal)
  assert.equal(h.proposalInput?.image.data[0], 99)
  assert.equal(h.presentedImage?.data[0], 88)
  assert.deepEqual(h.presentationCalls, [
    { ids: ['C00'], regions: [{ left: 2, top: 2, width: 4, height: 4 }] },
    { ids: ['C00'], regions: [{ left: 2, top: 2, width: 4, height: 4 }] },
  ])
  assert.ok(h.seenSignals.every((signal) => signal === h.signal))
  const providerText = JSON.stringify(h.requests)
  for (const secret of ['private-backend-name', 'private-source-path', 'private-native-score'])
    assert.equal(providerText.includes(secret), false)
  assert.ok(providerText.includes('C00'))
  assert.ok(providerText.includes('derived bounding rectangle'))
  assert.ok(providerText.includes('not pixel-mask completeness'))
  assert.ok(providerText.includes('The blue outline marks the SEED'))
  assert.ok(providerText.includes('presence'))
})

await test('four seed-center masks are preserved as one closed semantic candidate set', async () => {
  const batch = baseBatch({
    proposals: [
      {
        id: 'C00',
        mask: { data: rectMask(2, 2, 1, 1), width: 8, height: 8, format: 'binary-lsb0' },
        qualityScore: 0.99,
      },
      {
        id: 'C01',
        mask: { data: rectMask(2, 2, 2, 2), width: 8, height: 8, format: 'binary-lsb0' },
        qualityScore: 0.95,
      },
      {
        id: 'C02',
        mask: { data: rectMask(2, 2, 3, 3), width: 8, height: 8, format: 'binary-lsb0' },
        qualityScore: 0.9,
      },
      {
        id: 'C03',
        mask: { data: rectMask(2, 2, 4, 4), width: 8, height: 8, format: 'binary-lsb0' },
        qualityScore: 0.5,
      },
    ],
  })
  const h = harness({ batch, selection: 'C03', wholeScore: 0.9 })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'located')
  assert.deepEqual(h.presentationCalls[0]?.ids, ['C00', 'C01', 'C02', 'C03'])
  const choiceRequest = h.requests.find(
    (request) => request.questions.selection && !request.questions.presence,
  )
  assert.ok(choiceRequest)
  const choiceQuestion = choiceRequest.questions.selection
  assert.ok(choiceQuestion?.type === 'choice')
  assert.deepEqual(Object.keys(choiceQuestion.criteria), ['C00', 'C01', 'C02', 'C03', 'none'])
  assert.equal(
    JSON.stringify(choiceRequest.state).includes('qualityScore'),
    false,
    'native scores stay diagnostic and are not semantic selection inputs',
  )
  assert.equal(h.requests.at(-1)?.questions['presence']?.type, 'noul')
})

await test('proposal choice none and whole-target score at or below 0.5 stay unknown', async (t) => {
  await t.test('none', async () => {
    const h = harness({ selection: 'none' })
    const result = await locateFromProposals(h.input, h.dependencies, h.signal)
    assert.deepEqual(result.location.status, 'unknown')
    if (result.location.status === 'unknown')
      assert.equal(result.location.reason, 'extent-uncertain')
    assert.equal(result.mask, undefined)
    assert.equal(h.requests.length, 4) // three seed passes and one proposal Choice
    assert.equal(h.presentationCalls.length, 1)
  })
  await t.test('low confidence', async () => {
    const h = harness({ wholeScore: 0.5 })
    const result = await locateFromProposals(h.input, h.dependencies, h.signal)
    assert.deepEqual(result.location.status, 'unknown')
    if (result.location.status === 'unknown')
      assert.equal(result.location.reason, 'extent-uncertain')
    assert.equal(result.mask, undefined)
    assert.equal(h.requests.at(-1)?.questions['presence']?.type, 'noul')
    assert.equal(h.presentationCalls.length, 2)
  })
})

await test('box completeness accepts a sparse mask with the correct derived rectangle and focuses the final view', async () => {
  const sparse = rectMask(2, 2, 4, 4)
  for (let y = 2; y < 6; y += 1)
    for (let x = 2; x < 6; x += 1)
      if (x !== 2 && x !== 5 && y !== 2 && y !== 5) clearPackedPixel(sparse, x, y)
  const other = rectMask(2, 2, 1, 1)
  const batch = baseBatch({
    proposals: [
      { id: 'C00', mask: { data: other, width: 8, height: 8, format: 'binary-lsb0' } },
      { id: 'C01', mask: { data: sparse, width: 8, height: 8, format: 'binary-lsb0' } },
    ],
  })
  const h = harness({ batch, selection: 'C01', wholeScore: 0.9 })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'located')
  if (result.location.status !== 'located') return
  assert.deepEqual(result.location.region, { left: 2, top: 2, width: 4, height: 4 })
  assert.ok(result.mask)
  assert.equal(
    result.mask.data.reduce((sum, value) => sum + value, 0),
    12,
  )
  assert.deepEqual(h.presentationCalls, [
    {
      ids: ['C00', 'C01'],
      regions: [
        { left: 2, top: 2, width: 1, height: 1 },
        { left: 2, top: 2, width: 4, height: 4 },
      ],
    },
    { ids: ['C01'], regions: [{ left: 2, top: 2, width: 4, height: 4 }] },
  ])
  const selectionRequest = h.requests.at(-2)
  assert.ok(selectionRequest)
  const criteria = selectionRequest.questions['selection']
  assert.ok(criteria && criteria.type === 'choice')
  assert.match(criteria.criteria['C01'] ?? '', /left=2, top=2, width=4, height=4/)
  assert.match(criteria.instructions, /not pixel-mask completeness/)
  const finalRequest = h.requests.at(-1)
  assert.ok(finalRequest)
  assert.match(JSON.stringify(finalRequest.state), /single displayed candidate is C01/)
  assert.doesNotMatch(JSON.stringify(finalRequest.state), /C00/)
  assert.match(finalRequest.questions['presence']?.instructions ?? '', /box-completeness decision/)
})

await test('a mask with pixels outside hard ROI is rejected before model proposal selection', async () => {
  const outsideOnly = new Uint8Array(8).fill(0xff)
  for (let y = 2; y < 6; y += 1) {
    for (let x = 2; x < 6; x += 1) {
      const index = y * 8 + x
      outsideOnly[index >>> 3] = (outsideOnly[index >>> 3] ?? 0) & ~(1 << (index & 7))
    }
  }
  const batch = baseBatch({
    proposals: [
      { id: 'C00', mask: { data: outsideOnly, width: 8, height: 8, format: 'binary-lsb0' } },
    ],
  })
  const h = harness({ batch })
  await assert.rejects(
    locateFromProposals(h.input, h.dependencies, h.signal),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
  )
  assert.equal(h.requests.length, 3)
})

await test('nonseed candidates remain in Choice with their actual box, then fail the seed gate if selected', async () => {
  const batch = baseBatch({
    proposals: [
      {
        id: 'C00',
        mask: { data: rectMask(6, 6, 1, 1), width: 8, height: 8, format: 'binary-lsb0' },
      },
    ],
  })
  const h = harness({ batch, roi: { left: 0, top: 0, width: 8, height: 8 } })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'unknown')
  if (result.location.status === 'unknown')
    assert.equal(result.location.reason, 'extent-inconsistent')
  assert.deepEqual(h.presentedRegion, { left: 6, top: 6, width: 1, height: 1 })
  assert.equal(h.requests.length, 4)
})

await test('bbox overlap without a foreground seed pixel fails actual mask-seed intersection', async () => {
  const h = harness({
    roi: { left: 0, top: 0, width: 8, height: 8 },
    batchFactory: (input) => {
      const seed = input.seedRegion
      const mask = new Uint8Array(8)
      const seedRight = seed.left + seed.width
      const seedBottom = seed.top + seed.height
      for (let x = seed.left; x < seedRight && seedBottom < 8; x += 1)
        setPackedPixel(mask, x, seedBottom)
      for (let y = seed.top; y < seedBottom && seedRight < 8; y += 1)
        setPackedPixel(mask, seedRight, y)
      return baseBatch({
        proposals: [
          { id: 'C00', mask: { data: mask, width: 8, height: 8, format: 'binary-lsb0' } },
        ],
      })
    },
  })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'unknown')
  if (result.location.status === 'unknown')
    assert.equal(result.location.reason, 'extent-inconsistent')
  assert.ok(h.presentedRegion)
  assert.ok(h.proposalInput)
  const seed = h.proposalInput!.seedRegion
  assert.ok(h.presentedRegion!.left < seed.left + seed.width)
  assert.ok(h.presentedRegion!.left + h.presentedRegion!.width > seed.left)
  assert.ok(h.presentedRegion!.top < seed.top + seed.height)
  assert.ok(h.presentedRegion!.top + h.presentedRegion!.height > seed.top)
  assert.equal(h.requests.length, 4)
  assert.equal(h.requests.at(-1)?.questions['presence'], undefined)
})

await test('alpha-cleared proposal has no region and cannot be returned as a located mask', async () => {
  const h = harness({ transparentSource: true })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'unknown')
  if (result.location.status === 'unknown')
    assert.equal(result.location.reason, 'extent-inconsistent')
  assert.equal(result.mask, undefined)
  assert.equal(h.requests.length, 4)
})

await test('finite raw native quality diagnostics are preserved without bounding or prompt exposure', async () => {
  const batch = baseBatch({
    proposals: [
      {
        id: 'C00',
        mask: { data: rectMask(2, 2, 4, 4), width: 8, height: 8, format: 'binary-lsb0' },
        qualityScore: -12.5,
      },
    ],
    metadata: {
      method: 'fixture-proposals',
      backend: 'fixture-native',
      durationMs: 4,
      input: { width: 8, height: 8 },
      qualityScore: 18.25,
    },
  })
  const h = harness({ batch })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'located')
  assert.equal(result.segmentation?.qualityScore, 18.25)
  const requestText = JSON.stringify(h.requests)
  assert.equal(requestText.includes('-12.5'), false)
  assert.equal(requestText.includes('18.25'), false)
  assert.equal(requestText.includes('qualityScore'), false)
})

await test('seed absent result is preserved and skips proposal work', async () => {
  const h = harness({ seedAbsent: true })
  const result = await locateFromProposals(h.input, h.dependencies, h.signal)
  assert.equal(result.location.status, 'not-found')
  assert.equal(h.settled, 0)
  assert.equal(h.requests.length, 1)
})

await test('cancellation after presentation stops before model dispatch', async () => {
  const h = harness({ abortDuringPresentation: true })
  await assert.rejects(
    locateFromProposals(h.input, h.dependencies, h.signal),
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  assert.equal(h.requests.length, 3)
  assert.equal(h.settled, 0)
})

await test('cancellation during the focused final presentation prevents completeness dispatch', async () => {
  const h = harness({ abortDuringFocusedPresentation: true })
  await assert.rejects(
    locateFromProposals(h.input, h.dependencies, h.signal),
    (error: unknown) => error instanceof ClassifierError && error.code === 'ABORTED',
  )
  assert.equal(h.requests.length, 4) // Seed stages and candidate Choice only.
  assert.equal(h.presentationCalls.length, 2)
  assert.deepEqual(h.presentationCalls[1]?.ids, ['C00'])
})

await test('malformed source mask IDs and padding bits fail before model proposal selection', async (t) => {
  await t.test('nonsequential alias', async () => {
    const batch = baseBatch({
      proposals: [
        { id: 'C01', mask: { data: fullMask(), width: 8, height: 8, format: 'binary-lsb0' } },
      ],
    })
    const h = harness({ batch })
    await assert.rejects(
      locateFromProposals(h.input, h.dependencies, h.signal),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
    )
    assert.equal(h.requests.length, 3)
  })
  await t.test('nonzero unused packed bits', async () => {
    const mask = fullMask(7, 7)
    mask[mask.length - 1] = 0xff // seven high-order padding bits are unused
    const batch = baseBatch({
      proposals: [{ id: 'C00', mask: { data: mask, width: 7, height: 7, format: 'binary-lsb0' } }],
      metadata: {
        method: 'fixture-proposals',
        backend: 'private-backend-name',
        durationMs: 4,
        input: { width: 7, height: 7 },
      },
    })
    const h = harness({ batch, width: 7, height: 7, roi: { left: 1, top: 1, width: 5, height: 5 } })
    await assert.rejects(
      locateFromProposals(h.input, h.dependencies, h.signal),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
    )
    assert.equal(h.requests.length, 3)
  })
  await t.test('model alias outside the closed choice set', async () => {
    const h = harness({ selection: 'C35' })
    await assert.rejects(
      locateFromProposals(h.input, h.dependencies, h.signal),
      (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_RESPONSE',
    )
    assert.equal(h.requests.length, 4)
  })
})
