import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { test } from 'node:test'
import type {
  DecisionRequest,
  DecisionResult,
  RasterImage,
  RasterPort,
} from '../src/entities/contracts.js'
import type { PackedBinaryMask } from '../src/entities/object-proposals.js'
import type { RgbaRaster } from '../src/entities/representation.js'
import { ClassifierError } from '../src/entities/errors.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'
import {
  createH6ContextComposer,
  createSharpH6Presentation,
  H6ComposerFailure,
  type H6DecisionStage,
  type H6Family,
  type H6ProposalCandidate,
} from '../benchmarks/v03/h6-context-composer.js'
import {
  H6_QUERY_POLICY,
  H6_QUERY_POLICY_INSTRUCTIONS,
  H6_QUERY_POLICY_SHA256,
  resolveH6QueryPolicyId,
  type H6QueryPolicyId,
} from '../benchmarks/v03/h6-query-policy.js'

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

function rankedAnswer(request: DecisionRequest): DecisionResult {
  const question = request.questions.presence ?? request.questions.selection
  assert.ok(question?.type === 'choice')
  const keys = Object.keys(question.criteria)
  if (request.questions.presence)
    return {
      answers: { presence: { type: 'ranked-choice', ranking: ['present'] } },
      metadata: { ...metadata },
    }
  const ranking =
    question.rankingSize === 4
      ? keys.slice(0, Math.min(4, keys.length))
      : [keys.find((key) => key !== 'none') ?? 'none']
  return {
    answers: { selection: { type: 'ranked-choice', ranking } },
    metadata: { ...metadata },
  }
}

function scoredAnswer(request: DecisionRequest): DecisionResult {
  const question = request.questions.presence ?? request.questions.selection
  assert.ok(question?.type === 'choice')
  if (request.questions.presence)
    return answerChoice(request, 'presence', 'present', {
      present: 0.8,
      absent: 0.1,
      uncertain: 0.1,
    })
  const keys = Object.keys(question.criteria)
  const choice = keys.find((key) => key !== 'none') ?? 'none'
  const otherScore = keys.length > 1 ? 0.3 / (keys.length - 1) : 0
  const probabilities = Object.fromEntries(
    keys.map((key) => [key, key === choice ? 0.7 : otherScore]),
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

function captureRequest(request: DecisionRequest, authoredTarget = target): void {
  const strings = request.state.filter((part): part is string => typeof part === 'string')
  const text = strings.join('\n')
  assert.equal(text.split(authoredTarget).length - 1, 1, 'authored target must occur exactly once')
  assert.match(strings.at(-1) ?? '', /Authored target:/u, 'target is the final state item')
  const question = request.questions.presence ?? request.questions.selection
  assert.ok(question?.type === 'choice')
  for (const criterion of Object.values(question.criteria)) {
    assert.ok(!criterion.includes(target), 'choice criteria must use short aliases only')
    assert.ok(criterion.length < 100)
  }
}

function textAndQuestionsSha256(request: DecisionRequest): string {
  const textParts = request.state.filter((part): part is string => typeof part === 'string')
  return createHash('sha256')
    .update(JSON.stringify({ state: textParts, questions: request.questions }))
    .digest('hex')
}

function createHarness(
  inputFamilies: Readonly<Record<H6Family, readonly H6ProposalCandidate[]>>,
  decide: (
    request: DecisionRequest,
    signal: AbortSignal,
  ) => Promise<DecisionResult> | DecisionResult = async (request) => preferredAnswer(request),
  options?: {
    queryPolicyId?: H6QueryPolicyId
    imageState?: RasterPort['imageState']
    authoredTargetForCapture?: string
    image?: RgbaRaster
  },
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
        captureRequest(request, options?.authoredTargetForCapture)
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
    imageState: options?.imageState ?? (async (image) => mockImageState(image)),
    presentation,
    ...(options?.queryPolicyId !== undefined ? { queryPolicyId: options.queryPolicyId } : {}),
    budgetRecord: {
      admit({ stage, callOrdinal }) {
        budgetEvents.push({ type: 'admit', stage, ordinal: callOrdinal })
      },
      settle({ stage }) {
        budgetEvents.push({ type: 'settle', stage })
      },
    },
  })
  const image = options?.image ?? rgba(64, 48)
  const families = {
    D: inputFamilies.D,
    U: inputFamilies.U,
  }
  return { composer, image, families, stages, requests, budgetEvents }
}

await test('legacy query policy preserves all four captured text and question identities', async () => {
  const authoredTarget = 'the marked item within the described area'
  const exclusions = ['items outside the described area']
  const image = rgba(24, 20, [255, 255, 255])
  const families = {
    D: [
      candidate('D', 'native-d0', 24, 20, { left: 1, top: 1, width: 4, height: 4 }),
      candidate('D', 'native-d1', 24, 20, { left: 8, top: 1, width: 4, height: 4 }),
      candidate('D', 'native-d2', 24, 20, { left: 15, top: 1, width: 4, height: 4 }),
    ],
    U: [
      candidate('U', 'native-u0', 24, 20, { left: 1, top: 10, width: 4, height: 4 }),
      candidate('U', 'native-u1', 24, 20, { left: 8, top: 10, width: 4, height: 4 }),
      candidate('U', 'native-u2', 24, 20, { left: 15, top: 10, width: 4, height: 4 }),
    ],
  }
  const expected = [
    '79d8d6c6ef2d11197e5b2d92324f1249236fd2bc198b92f3d52cfe7628c3eb4c',
    '487c87f12676f63d3d9b2fba30692865f5a043ac36935dd807a3a59b49336069',
    '90f265b42b763b24db450a348716eae829d6f906ae5fc753aff97508a157ea9a',
    '4a8d321e6f2c1f2ea98bc4a1fa6902d79bfd31d3deda15de7f91b9af3e25e331',
  ]

  for (const queryPolicyId of [undefined, 'legacy-v1'] as const) {
    const harness = createHarness(families, rankedAnswer, {
      ...(queryPolicyId === undefined ? {} : { queryPolicyId }),
      imageState: createSharpRaster().imageState,
      image,
      authoredTargetForCapture: authoredTarget,
    })
    await harness.composer.compose({
      image: harness.image,
      target: authoredTarget,
      exclusions,
      families: harness.families,
      signal: new AbortController().signal,
    })
    assert.deepEqual(harness.requests.map(textAndQuestionsSha256), expected)
  }
  assert.equal(resolveH6QueryPolicyId(undefined), 'legacy-v1')
  assert.equal(resolveH6QueryPolicyId('legacy-v1'), 'legacy-v1')
})

await test('strict query policy augments all six existing instruction positions only', async () => {
  const families = {
    D: [
      candidate('D', 'native-d0', 64, 48, { left: 1, top: 1, width: 4, height: 4 }),
      candidate('D', 'native-d1', 64, 48, { left: 8, top: 1, width: 4, height: 4 }),
    ],
    U: [candidate('U', 'native-u0', 64, 48, { left: 1, top: 10, width: 4, height: 4 })],
  }
  const harness = createHarness(families, scoredAnswer, {
    queryPolicyId: 'strict-authored-scope-v1',
  })
  const result = await harness.composer.compose({
    image: harness.image,
    target,
    exclusions: ['outside the authored scope'],
    families: harness.families,
    signal: new AbortController().signal,
  })
  assert.equal(result.status, 'located')
  assert.deepEqual(harness.stages, ['presence', 'nominate-D', 'nominate-U', 'final-select'])
  const [presence, nominateD, nominateU, final] = harness.requests
  assert.ok(presence && nominateD && nominateU && final)
  const presenceQuestion = presence.questions.presence
  assert.ok(presenceQuestion?.type === 'choice')
  assert.equal(presenceQuestion.rankingSize, 1)
  assert.deepEqual(Object.keys(presenceQuestion.criteria), ['present', 'absent', 'uncertain'])
  const firstString = (request: DecisionRequest) =>
    request.state.find((part): part is string => typeof part === 'string')
  assert.equal(
    firstString(presence),
    'Determine whether the described visible instance exists anywhere in this unmodified source. Do not judge any candidate mask or its completeness. Choose present, absent, or uncertain. ' +
      H6_QUERY_POLICY_INSTRUCTIONS.presenceState,
  )
  assert.equal(
    presence.questions.presence?.instructions,
    'Choose the single best closed status for visible target presence. ' +
      H6_QUERY_POLICY_INSTRUCTIONS.presenceQuestion,
  )
  for (const request of [nominateD, nominateU]) {
    const question = request.questions.selection
    assert.ok(question?.type === 'choice')
    assert.equal(
      question.instructions,
      'Rank the strongest shown candidate aliases by semantic identity and relation. ' +
        H6_QUERY_POLICY_INSTRUCTIONS.nominationQuestion,
    )
    assert.equal(question.rankingSize, 4)
    assert.equal(Object.keys(question.criteria).at(-1), 'none')
  }
  const nominateDQuestion = nominateD.questions.selection
  const nominateUQuestion = nominateU.questions.selection
  assert.ok(nominateDQuestion?.type === 'choice')
  assert.ok(nominateUQuestion?.type === 'choice')
  assert.deepEqual(Object.keys(nominateDQuestion.criteria), ['D00', 'D01', 'none'])
  assert.deepEqual(Object.keys(nominateUQuestion.criteria), ['U00', 'none'])
  for (const request of [nominateD, nominateU]) {
    const stateText = request.state.filter((part): part is string => typeof part === 'string')
    assert.equal(
      stateText[0],
      `Rank up to four candidate aliases from family ${stateText[0]?.includes('family D') ? 'D' : 'U'} by semantic identity and the authored relation. Judge the pictured visible instance; do not demand pixel-perfect contours or infer hidden parts. Use none if this family has no matching instance. ` +
        H6_QUERY_POLICY_INSTRUCTIONS.nominationState,
    )
    assert.match(stateText.at(-1) ?? '', /^Authored target:/u)
    assert.equal(stateText.filter((part) => part.includes(target)).length, 1)
  }
  assert.equal(
    firstString(final),
    'Choose the best actual candidate mask for the requested visible instance. Prefer coverage of its whole visible extent and exclude substantial unrelated content. Occlusion gaps and disconnected visible pieces are allowed. Choose none if no candidate fits. ' +
      H6_QUERY_POLICY_INSTRUCTIONS.finalState,
  )
  const finalQuestion = final.questions.selection
  assert.ok(finalQuestion?.type === 'choice')
  assert.equal(
    finalQuestion.instructions,
    'Choose the best actual mask alias, or none. ' + H6_QUERY_POLICY_INSTRUCTIONS.finalQuestion,
  )
  assert.equal(finalQuestion.rankingSize, 1)
  assert.deepEqual(Object.keys(finalQuestion.criteria), ['D00', 'D01', 'U00', 'none'])
  assert.equal(
    final.state
      .filter((part) => typeof part === 'string')
      .at(-1)
      ?.includes(target),
    true,
  )
  assert.equal(H6_QUERY_POLICY.schema, 'h6-query-policy-v1')
  assert.equal(
    H6_QUERY_POLICY.hypothesisSha256,
    'dac1bf0eeecfaa204a70e3a89d5e16d7c64ced576a972923a3a1665287426ab2',
  )
  assert.equal(H6_QUERY_POLICY.compositionMode, 'append-to-legacy-instruction-v1')
  assert.deepEqual(Object.keys(H6_QUERY_POLICY), [
    'schema',
    'policyId',
    'hypothesisSha256',
    'compositionMode',
    'instructions',
  ])
  assert.ok(Object.isFrozen(H6_QUERY_POLICY))
  assert.ok(Object.isFrozen(H6_QUERY_POLICY.instructions))
  assert.deepEqual(Object.keys(H6_QUERY_POLICY.instructions), [
    'presenceState',
    'presenceQuestion',
    'nominationState',
    'nominationQuestion',
    'finalState',
    'finalQuestion',
  ])
  assert.equal(
    H6_QUERY_POLICY_SHA256,
    createHash('sha256').update(JSON.stringify(H6_QUERY_POLICY)).digest('hex'),
  )
  assert.equal(
    H6_QUERY_POLICY_SHA256,
    '8146bc76ed3166a1cf8573518d23765266bf53f9172f9794e1e85a3fe793d9bc',
  )
})

await test('unknown H6 query policy is rejected synchronously before port work', () => {
  let portCalls = 0
  assert.throws(
    () =>
      Reflect.apply(createH6ContextComposer, undefined, [
        {
          queryPolicyId: 'unrecognized-policy',
          decision: {
            async decide() {
              portCalls++
              return { answers: {}, metadata: { ...metadata } }
            },
          },
          imageState: async () => {
            portCalls++
            return []
          },
          presentation: {
            async renderPresence() {
              portCalls++
              return []
            },
            async renderNomination() {
              portCalls++
              return []
            },
            async renderFinal() {
              portCalls++
              return []
            },
          },
          budgetRecord: {
            admit() {
              portCalls++
            },
            settle() {
              portCalls++
            },
          },
        },
      ]),
    (error: unknown) => error instanceof ClassifierError && error.code === 'INVALID_INPUT',
  )
  assert.equal(portCalls, 0)
})

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
