import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import type {
  DecisionPort,
  DecisionRequest,
  DecisionResult,
  RasterImage,
} from '../src/entities/contracts.js'
import type { PackedBinaryMask } from '../src/entities/object-proposals.js'
import type { RgbaRaster } from '../src/entities/representation.js'
import {
  createH5ProposalComposer,
  createSharpH5Presentation,
  H5_LIMITS,
  type H5ComposerInput,
  type H5ComposerOptions,
  type H5DecisionBudgetRecordPort,
  type H5PresentationPort,
} from '../benchmarks/v03/h5-proposal-composer.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'
import { createOpenRouterDecisions } from '../src/openrouter.js'

const metadata = {
  model: 'fixture-model',
  provider: 'fixture-provider',
  requestId: null,
  durationMs: 1,
  costUsd: 0,
  attempts: 1,
} as const

function mask(
  points: readonly (readonly [number, number])[],
  width = 16,
  height = 12,
): PackedBinaryMask {
  const data = new Uint8Array(Math.ceil((width * height) / 8))
  for (const [x, y] of points) {
    const index = y * width + x
    data[index >> 3] = (data[index >> 3] ?? 0) | (1 << (index & 7))
  }
  return { data, width, height, format: 'binary-lsb0' }
}

function candidate(id: string, x: number, y = 4) {
  return {
    id,
    mask: mask([
      [x, y],
      [x + 1, y],
      [x, y + 1],
    ]),
  }
}

function source(): RgbaRaster {
  const data = new Uint8Array(16 * 12 * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 80
    data[index + 1] = 110
    data[index + 2] = 140
    data[index + 3] = 255
  }
  return { data, width: 16, height: 12, format: 'rgba8' }
}

async function png(): Promise<RasterImage> {
  const bytes = await sharp({
    create: { width: 16, height: 12, channels: 4, background: '#506e8c' },
  })
    .png()
    .toBuffer()
  return { bytes: new Uint8Array(bytes), width: 16, height: 12 }
}

function input(families: H5ComposerInput['families']): H5ComposerInput {
  return {
    image: source(),
    target: 'red bird',
    exclusions: ['branch'],
    families,
    signal: new AbortController().signal,
  }
}

function selectedKeys(request: DecisionRequest): string[] {
  const question = request.questions.selection
  assert.ok(question?.type === 'choice')
  return Object.keys(question.criteria)
}

function choice(
  request: DecisionRequest,
  scores: Readonly<Record<string, number>>,
  nativeChoice?: string,
): DecisionResult {
  const keys = selectedKeys(request)
  const probabilities = Object.fromEntries(keys.map((key) => [key, scores[key] ?? 0]))
  const winner =
    nativeChoice ??
    keys.reduce((best, key) =>
      (probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best,
    )
  return {
    answers: { selection: { type: 'choice', choice: winner, probabilities } },
    metadata,
  }
}

function defaultDecision(
  requestLog: DecisionRequest[],
  finalMode: 'first' | 'tie' | 'none' = 'first',
): DecisionPort {
  return {
    async decide(request) {
      requestLog.push(structuredClone(request))
      const keys = selectedKeys(request)
      const question = request.questions.selection
      assert.ok(question?.type === 'choice')
      if (question.rankingSize === 4) {
        const weights = keys.map((_, index) => keys.length - index)
        const total = weights.reduce((sum, score) => sum + score, 0)
        return choice(
          request,
          Object.fromEntries(keys.map((key, index) => [key, (weights[index] ?? 0) / total])),
        )
      }
      if (finalMode === 'none')
        return choice(request, Object.fromEntries(keys.map((key) => [key, Number(key === 'none')])))
      if (finalMode === 'tie')
        return choice(
          request,
          Object.fromEntries(keys.map((key) => [key, 1 / keys.length])),
          keys.at(-1),
        )
      return choice(
        request,
        Object.fromEntries(keys.map((key, index) => [key, Number(index === 0)])),
      )
    },
  }
}

function testPresentation(): H5PresentationPort {
  return {
    async renderNomination({ candidates }) {
      return await Promise.all(
        Array.from({ length: 1 + Math.ceil(candidates.length / 6) }, () => png()),
      )
    },
    async renderFinal({ candidates }) {
      return await Promise.all(Array.from({ length: 1 + candidates.length }, () => png()))
    },
  }
}

function budgetPort(
  onAdmit?: (stage: string, callOrdinal: number) => void,
): H5DecisionBudgetRecordPort {
  return {
    admit({ stage, callOrdinal }) {
      onAdmit?.(stage, callOrdinal)
    },
    settle() {},
  }
}

function imageWithDimensions(width: number, height: number): RgbaRaster {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      data[index] = (x * 7 + y * 3) % 256
      data[index + 1] = (y * 11 + x) % 256
      data[index + 2] = (x * 5 + y * 13) % 256
      data[index + 3] = 255
    }
  }
  return { data, width, height, format: 'rgba8' }
}

function paddedBounds(
  box: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
) {
  const padX = Math.max(16, Math.ceil(box.width * 0.5))
  const padY = Math.max(16, Math.ceil(box.height * 0.5))
  const left = Math.max(0, box.left - padX)
  const top = Math.max(0, box.top - padY)
  const right = Math.min(width, box.left + box.width + padX)
  const bottom = Math.min(height, box.top + box.height + padY)
  return { left, top, width: right - left, height: bottom - top }
}

async function expectedPanel(
  image: RgbaRaster,
  candidateMask: PackedBinaryMask,
  crop: ReturnType<typeof paddedBounds>,
  mode: 'clean' | 'overlay' | 'cutout',
): Promise<Buffer> {
  const pixels = Buffer.alloc(crop.width * crop.height * 4)
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const imageIndex = ((crop.top + y) * image.width + crop.left + x) * 4
      const panelIndex = (y * crop.width + x) * 4
      const foregroundIndex = (crop.top + y) * image.width + crop.left + x
      const foreground =
        ((candidateMask.data[foregroundIndex >> 3] ?? 0) & (1 << (foregroundIndex & 7))) !== 0
      if (mode === 'cutout' && !foreground) {
        pixels[panelIndex] = 128
        pixels[panelIndex + 1] = 128
        pixels[panelIndex + 2] = 128
        pixels[panelIndex + 3] = 255
      } else {
        const red = image.data[imageIndex] ?? 0
        const green = image.data[imageIndex + 1] ?? 0
        const blue = image.data[imageIndex + 2] ?? 0
        pixels[panelIndex] = mode === 'overlay' && foreground ? Math.round(red / 2) : red
        pixels[panelIndex + 1] =
          mode === 'overlay' && foreground ? Math.round((green + 255) / 2) : green
        pixels[panelIndex + 2] =
          mode === 'overlay' && foreground ? Math.round((blue + 255) / 2) : blue
        pixels[panelIndex + 3] = image.data[imageIndex + 3] ?? 255
      }
    }
  }
  return sharp(pixels, {
    raw: { width: crop.width, height: crop.height, channels: 4 },
  })
    .resize(288, 260, {
      fit: 'contain',
      kernel: 'nearest',
      background: { r: 20, g: 24, b: 32, alpha: 1 },
    })
    .raw()
    .toBuffer()
}

async function legacyLetterboxedOverlay(
  image: RgbaRaster,
  candidateMask: PackedBinaryMask,
  crop: ReturnType<typeof paddedBounds>,
): Promise<Buffer> {
  const sourceCrop = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .extract(crop)
    .resize(288, 260, {
      fit: 'contain',
      kernel: 'nearest',
      background: { r: 20, g: 24, b: 32, alpha: 1 },
    })
    .raw()
    .toBuffer()
  for (let y = 0; y < 260; y++) {
    for (let x = 0; x < 288; x++) {
      // This reproduces the previous mapping bug: it maps the entire padded panel
      // to the crop, ignoring the letterbox inserted by fit: contain.
      const imageX = crop.left + Math.floor(((x + 0.5) * crop.width) / 288)
      const imageY = crop.top + Math.floor(((y + 0.5) * crop.height) / 260)
      const foregroundIndex = imageY * image.width + imageX
      if (((candidateMask.data[foregroundIndex >> 3] ?? 0) & (1 << (foregroundIndex & 7))) === 0)
        continue
      const panelIndex = (y * 288 + x) * 4
      sourceCrop[panelIndex] = Math.round((sourceCrop[panelIndex] ?? 0) / 2)
      sourceCrop[panelIndex + 1] = Math.round(((sourceCrop[panelIndex + 1] ?? 0) + 255) / 2)
      sourceCrop[panelIndex + 2] = Math.round(((sourceCrop[panelIndex + 2] ?? 0) + 255) / 2)
    }
  }
  return sourceCrop
}

function differingPixels(left: Buffer, right: Buffer): number {
  let count = 0
  for (let offset = 0; offset < left.length; offset += 4) {
    if (
      left[offset] !== right[offset] ||
      left[offset + 1] !== right[offset + 1] ||
      left[offset + 2] !== right[offset + 2] ||
      left[offset + 3] !== right[offset + 3]
    )
      count++
  }
  return count
}

function assertPanelPixels(
  card: { data: Buffer; width: number },
  expected: Buffer,
  left: number,
  top: number,
): void {
  for (let y = 0; y < 260; y++) {
    const sourceStart = ((top + y) * card.width + left) * 4
    const expectedRow = expected.subarray(y * 288 * 4, (y + 1) * 288 * 4)
    const actualRow = card.data.subarray(sourceStart, sourceStart + 288 * 4)
    assert.deepEqual(actualRow, expectedRow)
  }
}

function composer(
  decision: DecisionPort,
  overrides: Partial<{
    presentation: H5PresentationPort
    budgetRecord: H5DecisionBudgetRecordPort
    imageState: H5ComposerOptions['imageState']
  }> = {},
) {
  const raster = createSharpRaster()
  return createH5ProposalComposer({
    decision,
    imageState: overrides.imageState ?? raster.imageState,
    presentation: overrides.presentation ?? testPresentation(),
    budgetRecord: overrides.budgetRecord ?? budgetPort(),
  })
}

await test('H5 runs both family nominations and returns only an actual stable finalist mask', async () => {
  const requests: DecisionRequest[] = []
  const result = await composer(defaultDecision(requests)).compose(
    input({ D: [candidate('d-original', 2)], U: [candidate('u-original', 11)] }),
  )

  assert.equal(result.status, 'located')
  if (result.status !== 'located') return
  assert.equal(result.family, 'D')
  assert.equal(result.alias, 'D00')
  assert.equal(result.sourceAlias, 'd-original')
  assert.deepEqual(result.region, { left: 2, top: 4, width: 2, height: 2 })
  assert.deepEqual(
    [...result.mask.data],
    [
      ...mask([
        [2, 4],
        [3, 4],
        [2, 5],
      ]).data,
    ],
  )
  assert.equal(requests.length, 3)
  assert.equal(
    requests[0]?.questions.selection?.type === 'choice' &&
      requests[0].questions.selection.rankingSize,
    4,
  )
  assert.equal(
    requests[1]?.questions.selection?.type === 'choice' &&
      requests[1].questions.selection.rankingSize,
    4,
  )
  assert.deepEqual(selectedKeys(requests[0]!), ['D00', 'none'])
  assert.deepEqual(selectedKeys(requests[1]!), ['U00', 'none'])
  assert.deepEqual(selectedKeys(requests[2]!), ['D00', 'U00', 'none'])
  assert.equal(requests[0]?.state.filter((part) => typeof part !== 'string').length, 2)
  assert.equal(requests[2]?.state.filter((part) => typeof part !== 'string').length, 3)
  const finalQuestion = requests[2]?.questions.selection
  assert.ok(finalQuestion?.type === 'choice')
  assert.match(finalQuestion.criteria.D00 ?? '', /"red bird"/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /"branch"/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /whole visible source extent/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /minor contour deviations/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /substantial unrelated/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /occlusion-created gaps/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /disconnected visible pieces/u)
  assert.match(finalQuestion.criteria.D00 ?? '', /do not infer pixels hidden/u)
  assert.match(finalQuestion.criteria.none ?? '', /nominated masks/u)
  assert.doesNotMatch(JSON.stringify(result), /coordinates|modelGenerated/u)
})

await test('H5 none consumes one top-four nomination slot and rank-only evidence stays rank-only', async () => {
  const requests: DecisionRequest[] = []
  const rankOnly: DecisionPort = {
    async decide(request) {
      requests.push(structuredClone(request))
      const keys = selectedKeys(request)
      const question = request.questions.selection
      assert.ok(question?.type === 'choice')
      if (question.rankingSize === 4) {
        const ranking = ['D00', 'D01', 'none', 'D02']
        return { answers: { selection: { type: 'ranked-choice', ranking } }, metadata }
      }
      return {
        answers: { selection: { type: 'ranked-choice', ranking: [keys[0] ?? 'none'] } },
        metadata,
      }
    },
  }
  const result = await composer(rankOnly).compose(
    input({ D: [0, 1, 2, 3, 4].map((index) => candidate(`source-${index}`, index + 1)), U: [] }),
  )

  assert.equal(result.status, 'located')
  assert.equal(result.nominations[0]?.selection.probabilities, null)
  assert.deepEqual(result.nominations[0]?.topFour, ['D00', 'D01', 'none', 'D02'])
  assert.deepEqual(result.nominations[0]?.nomineeAliases, ['D00', 'D01', 'D02'])
  assert.deepEqual(selectedKeys(requests[1]!), ['D00', 'D01', 'D02', 'none'])
})

await test('H5 raw categorical ties use stable candidate order at nomination and final selection', async () => {
  const requests: DecisionRequest[] = []
  const result = await composer(defaultDecision(requests, 'tie')).compose(
    input({ D: [candidate('first', 1), candidate('second', 8)], U: [] }),
  )
  assert.equal(result.status, 'located')
  if (result.status !== 'located') return
  assert.equal(result.alias, 'D00')
  assert.deepEqual(result.finalSelection.tied, ['D00', 'D01', 'none'])
  assert.equal(result.finalSelection.nativeChoice, 'none')
  assert.deepEqual(result.nominations[0]?.topFour, ['D00', 'D01', 'none'])
})

await test('H5 explicit none yields unknown and never synthesizes target absence or a location', async () => {
  const requests: DecisionRequest[] = []
  const result = await composer(defaultDecision(requests, 'none')).compose(
    input({ D: [candidate('one', 2)], U: [] }),
  )
  assert.equal(result.status, 'unknown')
  assert.equal(result.reason, 'none-selected')
  assert.equal(result.finalSelection?.choice, 'none')
  assert.equal(Object.hasOwn(result, 'region'), false)
  assert.equal(requests.length, 2)
})

await test('H5 snapshots caller inputs before async work and protects its packed mask from port mutation', async () => {
  const original = input({ D: [candidate('before', 3)], U: [] })
  const heldImage = original.image.data
  const heldMask = original.families.D[0]!.mask.data
  const requests: DecisionRequest[] = []
  const presentation: H5PresentationPort = {
    async renderNomination(args) {
      args.image.data.fill(0)
      args.candidates[0]?.mask.data.fill(0)
      await new Promise((resolve) => setTimeout(resolve, 0))
      return [await png(), await png()]
    },
    async renderFinal(args) {
      args.image.data.fill(0)
      args.candidates[0]?.mask.data.fill(0)
      return await Promise.all(Array.from({ length: 1 + args.candidates.length }, () => png()))
    },
  }
  const pending = composer(defaultDecision(requests), { presentation }).compose(original)
  original.image.data.fill(1)
  heldImage.fill(2)
  heldMask.fill(0)
  original.target = 'mutated target'
  ;(original.exclusions as string[])[0] = 'mutated exclusion'
  const result = await pending

  assert.equal(result.status, 'located')
  if (result.status !== 'located') return
  assert.equal(result.sourceAlias, 'before')
  assert.deepEqual(result.region, { left: 3, top: 4, width: 2, height: 2 })
  assert.match(JSON.stringify(requests), /red bird/u)
  assert.match(JSON.stringify(requests), /branch/u)
  assert.doesNotMatch(JSON.stringify(requests), /mutated target|mutated exclusion/u)
})

await test('H5 validates source/mask ownership and resource caps before presentation or decision', async () => {
  let calls = 0
  let presentations = 0
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      return defaultDecision([]).decide(request, new AbortController().signal)
    },
  }
  const presentation: H5PresentationPort = {
    async renderNomination() {
      presentations++
      return [await png(), await png()]
    },
    async renderFinal() {
      presentations++
      return [await png(), await png()]
    },
  }
  const service = composer(decision, { presentation })
  const invalidDimensions = input({ D: [candidate('one', 1)], U: [] })
  invalidDimensions.image.width = Number.MAX_SAFE_INTEGER
  await assert.rejects(service.compose(invalidDimensions))
  const noForeground = input({ D: [{ id: 'empty', mask: mask([]) }], U: [] })
  await assert.rejects(service.compose(noForeground))
  const tooMany = input({
    D: Array.from({ length: H5_LIMITS.familyCandidates + 1 }, (_, i) => candidate(`c${i}`, 1)),
    U: [],
  })
  await assert.rejects(service.compose(tooMany))
  assert.equal(calls, 0)
  assert.equal(presentations, 0)
})

await test('H5 budget denial prevents dispatch and admitted operations settle', async () => {
  let calls = 0
  const events: string[] = []
  const record: H5DecisionBudgetRecordPort = {
    admit({ stage, callOrdinal }) {
      events.push(`admit:${stage}:${callOrdinal}`)
      if (callOrdinal === 2) throw new Error('caller budget denied')
    },
    settle({ stage, outcome }) {
      events.push(`settle:${stage}:${outcome}`)
    },
  }
  const decision: DecisionPort = {
    async decide(request) {
      calls++
      return defaultDecision([]).decide(request, new AbortController().signal)
    },
  }
  await assert.rejects(
    composer(decision, { budgetRecord: record }).compose(
      input({ D: [candidate('d', 1)], U: [candidate('u', 10)] }),
    ),
    /caller budget denied/u,
  )
  assert.equal(calls, 1)
  assert.deepEqual(events, [
    'admit:nominate-D:1',
    'settle:nominate-D:resolved',
    'admit:nominate-U:2',
  ])
})

await test('H5 cancellation joins the admitted decision and cannot return a late location', async () => {
  let settleDecision: ((value: DecisionResult) => void) | undefined
  let entered: (() => void) | undefined
  let settles = 0
  let calls = 0
  const decision: DecisionPort = {
    decide(request) {
      calls++
      entered?.()
      return new Promise((resolve) => {
        settleDecision = resolve
        void request
      })
    },
  }
  const record: H5DecisionBudgetRecordPort = {
    admit() {},
    settle() {
      settles++
    },
  }
  const controller = new AbortController()
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const inputValue = input({ D: [candidate('d', 1)], U: [] })
  inputValue.signal = controller.signal
  const pending = composer(decision, { budgetRecord: record }).compose(inputValue)
  await started
  controller.abort(new Error('caller stopped'))
  const lateRequest: DecisionRequest = {
    state: [],
    questions: {
      selection: {
        type: 'choice',
        instructions: 'choose one',
        criteria: { D00: 'target', none: 'none' },
      },
    },
  }
  settleDecision?.(choice(lateRequest, { D00: 1, none: 0 }))
  await assert.rejects(pending)
  assert.equal(settles, 1)
  assert.equal(calls, 1)
})

await test('H5 sharp presentation builds one full source plus bounded family sheets and nominee cards', async () => {
  const image = source()
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    family: 'D' as const,
    alias: `D${String(index).padStart(2, '0')}`,
    sourceAlias: `source-${index}`,
    mask: mask([[index + 1, 4]]),
    bounds: { left: index + 1, top: 4, width: 1, height: 1 },
  }))
  const renderer = createSharpH5Presentation()
  const nomination = await renderer.renderNomination({
    image,
    candidates,
    signal: new AbortController().signal,
  })
  assert.equal(nomination.length, 3)
  const firstPixel = await sharp(nomination[1]!.bytes).raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([...firstPixel.data.subarray(0, 3)], [17, 24, 39])
  const final = await renderer.renderFinal({
    image,
    candidates: candidates.slice(0, 2),
    signal: new AbortController().signal,
  })
  assert.equal(final.length, 3)
  for (const view of [...nomination, ...final]) {
    const dimensions = await sharp(view.bytes).metadata()
    assert.ok(dimensions.width && dimensions.height)
    view.bytes.fill(0)
  }
})

await test('H5 final cards keep mask overlays and cutouts pixel-aligned for landscape and portrait crops', async () => {
  const cases = [
    { width: 64, height: 32, left: 40, top: 10, right: 51, bottom: 19 },
    { width: 32, height: 64, left: 10, top: 40, right: 21, bottom: 53 },
  ]
  const renderer = createSharpH5Presentation()
  for (const item of cases) {
    const image = imageWithDimensions(item.width, item.height)
    const points: Array<[number, number]> = []
    for (let y = item.top; y <= item.bottom; y++) {
      for (let x = item.left; x <= item.right; x++) points.push([x, y])
    }
    const packed = mask(points, item.width, item.height)
    const bounds = {
      left: item.left,
      top: item.top,
      width: item.right - item.left + 1,
      height: item.bottom - item.top + 1,
    }
    const [sourceView, cardView] = await renderer.renderFinal({
      image,
      candidates: [
        {
          family: 'D',
          alias: 'D00',
          sourceAlias: 'portrait-or-landscape',
          mask: packed,
          bounds,
        },
      ],
      signal: new AbortController().signal,
    })
    assert.ok(sourceView)
    assert.ok(cardView)
    const card = await sharp(cardView.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const crop = paddedBounds(bounds, image.width, image.height)
    const clean = await expectedPanel(image, packed, crop, 'clean')
    const overlay = await expectedPanel(image, packed, crop, 'overlay')
    const cutout = await expectedPanel(image, packed, crop, 'cutout')
    const legacyOverlay = await legacyLetterboxedOverlay(image, packed, crop)
    assert.ok(
      differingPixels(legacyOverlay, overlay) > 0,
      'the former letterbox-blind mask transform must fail pixel correspondence',
    )
    const cardPixels = { data: card.data, width: card.info.width }
    assertPanelPixels(cardPixels, clean, 4, 28)
    assertPanelPixels(cardPixels, overlay, 304, 28)
    assertPanelPixels(cardPixels, cutout, 604, 28)
    sourceView.bytes.fill(0)
    cardView.bytes.fill(0)
    clean.fill(0)
    overlay.fill(0)
    cutout.fill(0)
    legacyOverlay.fill(0)
    image.data.fill(0)
    packed.data.fill(0)
  }
})

await test('H5 uses the real Decisions adapter with explicit OpenAI route and mock fetch only', async () => {
  let physicalRequests = 0
  const mockFetch: typeof globalThis.fetch = async (_url, init) => {
    physicalRequests++
    const wire = JSON.parse(String(init?.body)) as DecisionRequest & {
      model: string
      provider: { only: string[]; allow_fallbacks: boolean }
    }
    assert.equal(wire.model, 'openai/gpt-6-luna-decisions')
    assert.deepEqual(wire.provider, { only: ['openai'], allow_fallbacks: false })
    const question = wire.questions.selection
    assert.ok(question?.type === 'choice')
    const keys = Object.keys(question.criteria)
    const winner = keys.find((key) => key !== 'none') ?? 'none'
    return new Response(
      JSON.stringify({
        id: `mock-${physicalRequests}`,
        model: wire.model,
        provider: 'OpenAI',
        answers: {
          selection: {
            type: 'choice',
            choice: winner,
            probabilities: Object.fromEntries(keys.map((key) => [key, Number(key === winner)])),
          },
        },
        usage: { input_tokens: 3, output_tokens: 2, cost: 0 },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const requests: DecisionRequest[] = []
  const capture: DecisionPort = {
    async decide(request, signal) {
      requests.push(structuredClone(request))
      return createOpenRouterDecisions({
        apiKey: 'test-only-key',
        model: 'openai/gpt-6-luna-decisions',
        provider: 'openai',
        providerName: 'OpenAI',
        fetch: mockFetch,
      }).decide(request, signal)
    },
  }
  const result = await composer(capture, { imageState: createSharpRaster().imageState }).compose(
    input({ D: [candidate('d', 1)], U: [candidate('u', 10)] }),
  )
  assert.equal(result.status, 'located')
  assert.equal(physicalRequests, 3)
  assert.equal(requests.length, 3)
  assert.equal(
    requests[0]?.questions.selection?.type === 'choice' &&
      requests[0].questions.selection.rankingSize,
    4,
  )
  assert.equal(result.nominations[0]?.topFour.length, 2)
  assert.ok(
    requests.every(
      (request) => request.state.filter((part) => typeof part !== 'string').length <= 9,
    ),
  )
})
