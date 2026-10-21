import assert from 'node:assert/strict'
import sharp from 'sharp'
import { test } from 'node:test'
import type { DecisionRequest, DecisionResult, RasterImage } from '../src/entities/contracts.js'
import type { PackedBinaryMask } from '../src/entities/object-proposals.js'
import type { RgbaRaster } from '../src/entities/representation.js'
import { ClassifierError } from '../src/entities/errors.js'
import {
  createH6ContextComposer,
  createSharpH6Presentation,
  H6ComposerFailure,
  type H6DecisionStage,
  type H6Family,
  type H6ProposalCandidate,
} from '../benchmarks/v03/h6-context-composer.js'

const target = 'the small amber marker beside the north road'
const metadata = {
  model: 'mock-model',
  provider: 'mock-provider',
  requestId: 'mock-request',
  durationMs: 1,
  costUsd: 0,
  attempts: 1,
}

function rgba(
  width: number,
  height: number,
  color: readonly [number, number, number] = [30, 40, 50],
): RgbaRaster {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = color[0]
    data[index * 4 + 1] = color[1]
    data[index * 4 + 2] = color[2]
    data[index * 4 + 3] = 255
  }
  return { data, width, height, format: 'rgba8' }
}

function mask(
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
): PackedBinaryMask {
  const pixels = width * height
  const data = new Uint8Array(Math.ceil(pixels / 8))
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const index = y * width + x
      data[index >> 3] = (data[index >> 3] ?? 0) | (1 << (index & 7))
    }
  }
  return { data, width, height, format: 'binary-lsb0' }
}

function candidate(
  family: H6Family,
  id: string,
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
): H6ProposalCandidate {
  return { id, mask: mask(width, height, rect) }
}

function answerChoice(
  request: DecisionRequest,
  key: string,
  choice: string,
  probabilities: Record<string, number>,
): DecisionResult {
  return {
    answers: { [key]: { type: 'choice', choice, probabilities } },
    metadata: { ...metadata },
  }
}

function preferredAnswer(request: DecisionRequest): DecisionResult {
  const question = request.questions.presence ?? request.questions.selection
  assert.ok(question?.type === 'choice')
  const keys = Object.keys(question.criteria)
  if (request.questions.presence) {
    return answerChoice(request, 'presence', 'present', {
      present: 0.8,
      absent: 0.1,
      uncertain: 0.1,
    })
  }
  if (question.rankingSize === 4) {
    const weights = keys.map((key) =>
      key === 'none'
        ? 0.29
        : key === 'D00'
          ? 0.3
          : key === 'D01'
            ? 0.2
            : key === 'D02'
              ? 0.12
              : 0.09,
    )
    const total = weights.reduce((sum, value) => sum + value, 0)
    const probabilities: Record<string, number> = {}
    for (const [index, key] of keys.entries()) {
      probabilities[key] = (weights[index] ?? 0) / total
    }
    return answerChoice(request, 'selection', keys[0] ?? 'none', probabilities)
  }
  const choice = keys.includes('D00') ? 'D00' : (keys[0] ?? 'none')
  const probabilities = Object.fromEntries(
    keys.map((key) => [key, key === choice ? 0.8 : 0.2 / (keys.length - 1)]),
  )
  return answerChoice(request, 'selection', choice, probabilities)
}

function mockImageState(image: RasterImage) {
  return [
    {
      type: 'image_url' as const,
      image_url: {
        url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`,
        detail: 'high' as const,
      },
    },
  ]
}

function captureRequest(request: DecisionRequest): void {
  const strings = request.state.filter((part): part is string => typeof part === 'string')
  const text = strings.join('\n')
  assert.equal(text.split(target).length - 1, 1, 'authored target must occur exactly once')
  assert.match(strings.at(-1) ?? '', /Authored target:/u, 'target is the final state item')
  const question = request.questions.presence ?? request.questions.selection
  assert.ok(question?.type === 'choice')
  for (const criterion of Object.values(question.criteria)) {
    assert.ok(!criterion.includes(target), 'choice criteria must use short aliases only')
    assert.ok(criterion.length < 100)
  }
}

function createHarness(
  inputFamilies: Readonly<Record<H6Family, readonly H6ProposalCandidate[]>>,
  decide: (
    request: DecisionRequest,
    signal: AbortSignal,
  ) => Promise<DecisionResult> | DecisionResult = async (request) => preferredAnswer(request),
) {
  const stages: H6DecisionStage[] = []
  const requests: DecisionRequest[] = []
  const budgetEvents: Array<{
    type: 'admit' | 'settle'
    stage: H6DecisionStage
    ordinal?: number
  }> = []
  const presentation = createSharpH6Presentation()
  const composer = createH6ContextComposer({
    decision: {
      async decide(request, signal) {
        captureRequest(request)
        requests.push(structuredClone(request))
        const stateText = request.state.filter((part): part is string => typeof part === 'string')
        stages.push(
          request.questions.presence
            ? 'presence'
            : stateText.some((part) => part.includes('from family D'))
              ? 'nominate-D'
              : stateText.some((part) => part.includes('from family U'))
                ? 'nominate-U'
                : 'final-select',
        )
        return decide(request, signal)
      },
    },
    imageState: async (image) => mockImageState(image),
    presentation,
    budgetRecord: {
      admit({ stage, callOrdinal }) {
        budgetEvents.push({ type: 'admit', stage, ordinal: callOrdinal })
      },
      settle({ stage }) {
        budgetEvents.push({ type: 'settle', stage })
      },
    },
  })
  const image = rgba(64, 48)
  const families = {
    D: inputFamilies.D,
    U: inputFamilies.U,
  }
  return { composer, image, families, stages, requests, budgetEvents }
}

await test('presence uses stable raw Choice maxima and short-circuits absent and uncertain', async () => {
  for (const [nativeChoice, expected, reason] of [
    ['absent', 'present', undefined],
    ['absent', 'absent', 'target-absent'],
    ['uncertain', 'uncertain', 'presence-unresolved'],
  ] as const) {
    let count = 0
    const harness = createHarness({ D: [], U: [] }, async (request) => {
      count++
      if (expected === 'present') {
        return answerChoice(request, 'presence', nativeChoice, {
          present: 0.5,
          absent: 0.5,
          uncertain: 0,
        })
      }
      const probabilities = { present: 0.1, absent: 0.8, uncertain: 0.1 }
      if (expected === 'uncertain') {
        return answerChoice(request, 'presence', 'uncertain', {
          present: 0.25,
          absent: 0.25,
          uncertain: 0.5,
        })
      }
      return answerChoice(request, 'presence', nativeChoice, probabilities)
    })
    const result = await harness.composer.compose({
      image: harness.image,
      target,
      exclusions: [],
      families: harness.families,
      signal: new AbortController().signal,
    })
    assert.equal(count, 1)
    assert.equal(result.presence.selection.choice, expected)
    if (expected === 'present') {
      assert.equal(result.status, 'unknown')
      assert.equal(result.reason, 'no-nominees')
    } else {
      assert.equal(result.status, 'unknown')
      assert.equal(result.reason, reason)
      assert.deepEqual(result.nominations, [])
    }
  }
})

await test('tied raw presence maxima use supplied order and each request states target once', async () => {
  const harness = createHarness(
    {
      D: [candidate('D', 'native-d', 64, 48, { left: 5, top: 6, width: 8, height: 7 })],
      U: [],
    },
    async (request) => {
      if (request.questions.presence)
        return answerChoice(request, 'presence', 'absent', {
          present: 0.5,
          absent: 0.5,
          uncertain: 0,
        })
      return preferredAnswer(request)
    },
  )
  const result = await harness.composer.compose({
    image: harness.image,
    target,
    exclusions: [],
    families: harness.families,
    signal: new AbortController().signal,
  })
  assert.equal(result.presence.selection.nativeChoice, 'absent')
  assert.equal(result.presence.selection.choice, 'present')
  assert.deepEqual(result.presence.selection.tied, ['present', 'absent'])
  assert.ok(
    harness.requests.every(
      (request) =>
        request.state
          .filter((part) => typeof part === 'string')
          .join('\n')
          .split(target).length -
          1 ===
        1,
    ),
  )
  assert.deepEqual(
    harness.budgetEvents.filter((event) => event.type === 'admit').map((event) => event.ordinal),
    [1, 2, 3],
  )
})

await test('nomination keeps none in the top four and final returns the actual input mask', async () => {
  const candidates = ['a', 'b', 'c', 'd'].map((id, index) =>
    candidate('D', id, 64, 48, { left: 4 + index * 10, top: 8, width: 5, height: 5 }),
  )
  const harness = createHarness({ D: candidates, U: [] })
  const result = await harness.composer.compose({
    image: harness.image,
    target,
    exclusions: [],
    families: harness.families,
    signal: new AbortController().signal,
  })
  assert.equal(result.status, 'located')
  assert.equal(result.alias, 'D00')
  assert.equal(result.sourceAlias, 'a')
  assert.deepEqual(result.nominations[0]?.topFour, ['D00', 'none', 'D01', 'D02'])
  assert.deepEqual(result.nominations[0]?.nomineeAliases, ['D00', 'D01', 'D02'])
  assert.deepEqual([...result.mask.data], [...candidates[0]!.mask.data])
  assert.deepEqual(harness.stages, ['presence', 'nominate-D', 'final-select'])
  assert.deepEqual(
    harness.budgetEvents.filter((event) => event.type === 'admit').map((event) => event.ordinal),
    [1, 2, 3],
  )
})

await test('late caller mutation cannot change snapshotted target, alias, image, or mask', async () => {
  const source = rgba(64, 48)
  const sourceMask = mask(64, 48, { left: 10, top: 12, width: 9, height: 7 })
  const families = { D: [{ id: 'native-original', mask: sourceMask }], U: [] }
  let authoredTarget = target
  let letPresenceResolve: ((value: DecisionResult) => void) | undefined
  let started: (() => void) | undefined
  const first = new Promise<DecisionResult>((resolve) => {
    letPresenceResolve = resolve
  })
  const onStart = new Promise<void>((resolve) => {
    started = resolve
  })
  const harness = createHarness(families, async (request) => {
    if (request.questions.presence) {
      started?.()
      return first
    }
    return preferredAnswer(request)
  })
  const pending = harness.composer.compose({
    image: source,
    target: authoredTarget,
    exclusions: [],
    families,
    signal: new AbortController().signal,
  })
  await onStart
  authoredTarget = 'mutated after compose started'
  source.data.fill(0)
  sourceMask.data.fill(0)
  families.D[0]!.id = 'mutated-alias'
  letPresenceResolve?.(
    answerChoice(harness.requests[0]!, 'presence', 'present', {
      present: 0.8,
      absent: 0.1,
      uncertain: 0.1,
    }),
  )
  const result = await pending
  assert.equal(result.status, 'located')
  assert.equal(result.sourceAlias, 'native-original')
  assert.deepEqual(result.region, { left: 10, top: 12, width: 9, height: 7 })
  assert.ok(result.mask.data.some((value) => value !== 0))
})

await test('post-presence failure carries raw presence and completed nominations', async () => {
  const harness = createHarness(
    {
      D: [candidate('D', 'native-d', 64, 48, { left: 2, top: 2, width: 5, height: 5 })],
      U: [],
    },
    async (request) => {
      if (request.questions.presence) return preferredAnswer(request)
      throw new ClassifierError('PROVIDER', 'mock nomination failure')
    },
  )
  await assert.rejects(
    harness.composer.compose({
      image: harness.image,
      target,
      exclusions: [],
      families: harness.families,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof H6ComposerFailure)
      assert.equal(error.partial.presence?.selection.choice, 'present')
      assert.deepEqual(error.partial.nominations, [])
      assert.equal(error.code, 'PROVIDER')
      return true
    },
  )
})

await test('cancellation settles the admitted operation as failed and cannot return late success', async () => {
  const controller = new AbortController()
  let notifyStart: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    notifyStart = resolve
  })
  const harness = createHarness({ D: [], U: [] }, async (_request, signal) => {
    notifyStart?.()
    return await new Promise<DecisionResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const pending = harness.composer.compose({
    image: harness.image,
    target,
    exclusions: [],
    families: harness.families,
    signal: controller.signal,
  })
  await started
  controller.abort(new ClassifierError('ABORTED', 'test cancellation'))
  await assert.rejects(pending, H6ComposerFailure)
  assert.deepEqual(
    harness.budgetEvents.map((event) => [event.type, event.stage]),
    [
      ['admit', 'presence'],
      ['settle', 'presence'],
    ],
  )
})

await test('an adapter success arriving after cancellation cannot become a located result', async () => {
  const controller = new AbortController()
  let release: ((value: DecisionResult) => void) | undefined
  let notifyStart: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    notifyStart = resolve
  })
  const harness = createHarness({ D: [], U: [] }, async () => {
    notifyStart?.()
    return await new Promise<DecisionResult>((resolve) => {
      release = resolve
    })
  })
  const pending = harness.composer.compose({
    image: harness.image,
    target,
    exclusions: [],
    families: harness.families,
    signal: controller.signal,
  })
  await started
  controller.abort(new ClassifierError('ABORTED', 'cancel before delayed adapter result'))
  release?.(
    answerChoice(harness.requests[0]!, 'presence', 'present', {
      present: 0.8,
      absent: 0.1,
      uncertain: 0.1,
    }),
  )
  await assert.rejects(pending, H6ComposerFailure)
  assert.deepEqual(harness.stages, ['presence'])
  assert.deepEqual(
    harness.budgetEvents.map((event) => [event.type, event.stage]),
    [
      ['admit', 'presence'],
      ['settle', 'presence'],
    ],
  )
})

function expectedContext(
  bounds: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
) {
  const cropWidth = Math.min(width, Math.max(4 * bounds.width, 128))
  const cropHeight = Math.min(height, Math.max(4 * bounds.height, 128))
  const left = Math.max(
    0,
    Math.min(width - cropWidth, Math.floor(bounds.left + bounds.width / 2 - cropWidth / 2)),
  )
  const top = Math.max(
    0,
    Math.min(height - cropHeight, Math.floor(bounds.top + bounds.height / 2 - cropHeight / 2)),
  )
  return { left, top, width: cropWidth, height: cropHeight }
}

await test('portrait, landscape, and clipped-edge atlas overlays keep exact source-mask alignment', async () => {
  const cases = [
    { width: 512, height: 256, bounds: { left: 390, top: 100, width: 80, height: 20 } },
    { width: 256, height: 512, bounds: { left: 30, top: 390, width: 20, height: 80 } },
    { width: 128, height: 512, bounds: { left: 3, top: 452, width: 25, height: 50 } },
  ]
  for (const item of cases) {
    const image = rgba(item.width, item.height)
    const bounds = item.bounds
    for (let y = bounds.top; y < bounds.top + bounds.height; y++) {
      for (let x = bounds.left; x < bounds.left + bounds.width; x++) {
        const index = (y * item.width + x) * 4
        image.data[index] = 200
        image.data[index + 1] = 0
        image.data[index + 2] = 0
      }
    }
    const candidateValue = candidate('D', 'native-mark', item.width, item.height, bounds)
    const views = await createSharpH6Presentation().renderNomination({
      image,
      candidates: [
        {
          family: 'D',
          alias: 'D00',
          sourceAlias: candidateValue.id,
          mask: candidateValue.mask,
          bounds,
        },
      ],
      signal: new AbortController().signal,
    })
    assert.equal(views.length, 2)
    const page = views[1]
    assert.ok(page)
    const decoded = await sharp(page.bytes).raw().toBuffer({ resolveWithObject: true })
    const crop = expectedContext(bounds, item.width, item.height)
    const scale = Math.min(448 / crop.width, 344 / crop.height)
    const scaledWidth = Math.round(crop.width * scale)
    const scaledHeight = Math.round(crop.height * scale)
    const padX = Math.floor((448 - scaledWidth) / 2)
    const padY = Math.floor((344 - scaledHeight) / 2)
    const sampleSourceX = bounds.left + Math.floor(bounds.width / 2)
    const sampleSourceY = bounds.top + Math.floor(bounds.height / 2)
    const sampleX = 16 + padX + Math.floor((sampleSourceX - crop.left + 0.5) * scale)
    const sampleY = 40 + padY + Math.floor((sampleSourceY - crop.top + 0.5) * scale)
    const pixelIndex = (sampleY * decoded.info.width + sampleX) * decoded.info.channels
    assert.deepEqual(
      [...decoded.data.subarray(pixelIndex, pixelIndex + 3)],
      [100, 128, 128],
      `misaligned overlay for ${item.width}x${item.height} at ${sampleX},${sampleY}`,
    )
    page.bytes.fill(0)
    views[0]?.bytes.fill(0)
    image.data.fill(0)
  }
})

await test('nomination atlas is capped at four ordered pages for 36 candidates', async () => {
  const image = rgba(128, 128)
  const candidates = Array.from({ length: 36 }, (_, index) => ({
    family: 'D' as const,
    alias: `D${String(index).padStart(2, '0')}`,
    sourceAlias: `native-${index}`,
    mask: mask(128, 128, {
      left: (index % 6) * 18,
      top: Math.floor(index / 6) * 18,
      width: 4,
      height: 4,
    }),
    bounds: { left: (index % 6) * 18, top: Math.floor(index / 6) * 18, width: 4, height: 4 },
  }))
  const views = await createSharpH6Presentation().renderNomination({
    image,
    candidates,
    signal: new AbortController().signal,
  })
  assert.equal(views.length, 5)
  assert.deepEqual(
    views.slice(1).map(({ width, height }) => [width, height]),
    Array(4).fill([1440, 1440]),
  )
  for (const view of views) view.bytes.fill(0)
  image.data.fill(0)
  for (const item of candidates) item.mask.data.fill(0)
})

await test('atlas tiles preserve supplied alias order and overlay their corresponding masks', async () => {
  const image = rgba(128, 128)
  const firstBounds = { left: 10, top: 10, width: 8, height: 8 }
  const secondBounds = { left: 90, top: 80, width: 8, height: 8 }
  for (let y = firstBounds.top; y < firstBounds.top + firstBounds.height; y++) {
    for (let x = firstBounds.left; x < firstBounds.left + firstBounds.width; x++) {
      const index = (y * image.width + x) * 4
      image.data[index] = 200
      image.data[index + 1] = 0
      image.data[index + 2] = 0
    }
  }
  for (let y = secondBounds.top; y < secondBounds.top + secondBounds.height; y++) {
    for (let x = secondBounds.left; x < secondBounds.left + secondBounds.width; x++) {
      const index = (y * image.width + x) * 4
      image.data[index] = 0
      image.data[index + 1] = 200
      image.data[index + 2] = 0
    }
  }
  const first = candidate('D', 'native-first', 128, 128, firstBounds)
  const second = candidate('D', 'native-second', 128, 128, secondBounds)
  const views = await createSharpH6Presentation().renderNomination({
    image,
    candidates: [
      { family: 'D', alias: 'D00', sourceAlias: first.id, bounds: firstBounds, mask: first.mask },
      {
        family: 'D',
        alias: 'D01',
        sourceAlias: second.id,
        bounds: secondBounds,
        mask: second.mask,
      },
    ],
    signal: new AbortController().signal,
  })
  const page = views[1]
  assert.ok(page)
  const decoded = await sharp(page.bytes).raw().toBuffer({ resolveWithObject: true })
  const sample = (x: number, y: number) => {
    const index = (y * decoded.info.width + x) * decoded.info.channels
    return [...decoded.data.subarray(index, index + 3)]
  }
  const scale = Math.min(448 / 128, 344 / 128)
  const padX = Math.floor((448 - Math.round(128 * scale)) / 2)
  const firstX = 16 + padX + Math.floor((firstBounds.left + 4.5) * scale)
  const firstY = 40 + Math.floor((firstBounds.top + 4.5) * scale)
  const secondX = 480 + 16 + padX + Math.floor((secondBounds.left + 4.5) * scale)
  const secondY = 40 + Math.floor((secondBounds.top + 4.5) * scale)
  assert.deepEqual(sample(firstX, firstY), [100, 128, 128])
  assert.deepEqual(sample(secondX, secondY), [0, 228, 128])
  page.bytes.fill(0)
  views[0]?.bytes.fill(0)
  image.data.fill(0)
  first.mask.data.fill(0)
  second.mask.data.fill(0)
})
