import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { RunBudget } from '../benchmarks/v02/budget.js'
import {
  JEV_NATIVE_BOX_EXPECTED_CASE_IDS,
  JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
  JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
  JEV_NATIVE_BOX_MANIFEST_LOCKS,
  JEV_NATIVE_BOX_MODEL,
  JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD,
  authoredTargetStateLine,
  buildJevNativeBoxWireBody,
  convertNormalizedBoxToSourceBox,
  mapNoulScoreToPresence,
  parseJevNativeBoxResponse,
  parseJevNativeBoxResponseEnvelope,
  parseSourceImageTransformFromImageState,
  sha256Bytes,
  validateJevNativeBoxResponseMetadata,
  validateNormalizedProviderBox,
  type SourceImageTransformMetadata,
} from '../benchmarks/v03/jev-native-box.js'
import { scoreJevNativeBoxRow } from '../benchmarks/v03/evaluate-jev-native-box.js'
import {
  hashJevNativeBoxSourceClosure as hashRunClosure,
  readBoundedJevNativeBoxResponseBody,
  releasePhysicalBudget,
} from '../benchmarks/v03/run-jev-native-box.js'
import { createSharpRaster } from '../src/infrastructure/raster.js'

const repositoryRoot = resolve('.')

await test('wire body uses one image, one authored target, native box+noul questions', async () => {
  const target = 'Car'
  const imagePart = {
    type: 'image_url' as const,
    image_url: { url: 'data:image/png;base64,AA==', detail: 'high' as const },
  }
  const body = buildJevNativeBoxWireBody(target, imagePart)
  assert.equal(body.model, JEV_NATIVE_BOX_MODEL)
  assert.deepEqual(body.provider, { only: ['typesafe'], allow_fallbacks: false })
  assert.equal(body.state.length, 2)
  assert.equal(body.state[0]?.type, 'image_url')
  assert.equal(body.state[1], authoredTargetStateLine(target))
  assert.equal(body.questions.presence.instructions, JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION)
  assert.equal(body.questions.object.instructions, JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION)
  assert.equal(JSON.stringify(body.state).split(target).length - 1, 1)
  assert.doesNotMatch(body.questions.object.instructions, /unknown/iu)
})

await test('noul mapping follows the frozen half-open boundaries', () => {
  assert.equal(mapNoulScoreToPresence(0.51), 'present')
  assert.equal(mapNoulScoreToPresence(0.49), 'absent')
  assert.equal(mapNoulScoreToPresence(0.5), 'uncertain')
})

await test('normalized box validation rejects malformed geometry', () => {
  assert.throws(
    () => validateNormalizedProviderBox({ left: 0.2, top: 0.2, right: 0.1, bottom: 0.4 }),
    /unordered/u,
  )
  assert.throws(
    () => validateNormalizedProviderBox({ left: -0.1, top: 0.1, right: 0.2, bottom: 0.3 }),
    /unit-range/u,
  )
})

await test('source transform conversion handles portrait and landscape letterboxing', () => {
  const landscape: SourceImageTransformMetadata = {
    source: { width: 400, height: 200 },
    output: { width: 400, height: 280 },
    content: { left: 0, top: 40, width: 400, height: 200 },
    scaleX: 1,
    scaleY: 1,
  }
  const portrait: SourceImageTransformMetadata = {
    source: { width: 200, height: 400 },
    output: { width: 280, height: 400 },
    content: { left: 40, top: 0, width: 200, height: 400 },
    scaleX: 1,
    scaleY: 1,
  }
  const landBox = convertNormalizedBoxToSourceBox(
    { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 },
    landscape,
  )
  assert.ok(landBox.width > 0 && landBox.height > 0)
  assert.throws(
    () => convertNormalizedBoxToSourceBox({ left: 0, top: 0, right: 0.2, bottom: 0.1 }, landscape),
    /padding-only/u,
  )
  const portBox = convertNormalizedBoxToSourceBox(
    { left: 0.3, top: 0.2, right: 0.7, bottom: 0.8 },
    portrait,
  )
  assert.ok(portBox.left >= 0 && portBox.top >= 0)
  assert.ok(portBox.left + portBox.width <= portrait.source.width)
})

await test('normalized box conversion preserves exact float mapping inside content', () => {
  const transform: SourceImageTransformMetadata = {
    source: { width: 800, height: 600 },
    output: { width: 800, height: 600 },
    content: { left: 0, top: 0, width: 800, height: 600 },
    scaleX: 2,
    scaleY: 3,
  }
  const mapped = convertNormalizedBoxToSourceBox(
    { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 },
    transform,
  )
  assert.equal(mapped.left, 40)
  assert.equal(mapped.top, 40)
  assert.equal(mapped.width, 80)
  assert.equal(mapped.height, 40)
})

await test('normalized box conversion rejects partial padding overlap without clamping', () => {
  const transform: SourceImageTransformMetadata = {
    source: { width: 100, height: 100 },
    output: { width: 200, height: 200 },
    content: { left: 50, top: 50, width: 100, height: 100 },
    scaleX: 1,
    scaleY: 1,
  }
  assert.throws(
    () =>
      convertNormalizedBoxToSourceBox({ left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 }, transform),
    /padding-only/u,
  )
})

await test('createSharpRaster imageState transform maps extreme letterbox continuously', async () => {
  const raster = createSharpRaster()
  const png = await sharp({
    create: {
      width: 50,
      height: 400,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 255 },
    },
  })
    .png()
    .toBuffer()
  const normalized = await raster.normalize(png, new AbortController().signal)
  const state = await raster.imageState(normalized, new AbortController().signal)
  const transform = parseSourceImageTransformFromImageState(state)
  const box = convertNormalizedBoxToSourceBox(
    { left: 0.45, top: 0.2, right: 0.55, bottom: 0.8 },
    transform,
  )
  assert.ok(box.height > box.width)
})

await test('source closure hash is stable', async () => {
  const first = await hashRunClosure(repositoryRoot)
  const second = await hashRunClosure(repositoryRoot)
  assert.equal(first.sha256, second.sha256)
  assert.ok(first.files.length > 5)
})

await test('releasePhysicalBudget cancels reservation when fetch was not invoked', () => {
  const budget = new RunBudget(12, 0.25, JEV_NATIVE_BOX_UNKNOWN_RESERVE_USD)
  const physicalId = budget.admit()
  assert.equal(budget.snapshot().admittedPhysicalCalls, 1)
  assert.equal(budget.snapshot().inFlightCalls, 1)
  releasePhysicalBudget(budget, physicalId, false, null)
  assert.equal(budget.snapshot().admittedPhysicalCalls, 0)
  assert.equal(budget.snapshot().inFlightCalls, 0)
  assert.equal(budget.snapshot().unknownCostCalls, 0)
})

await test('readBoundedJevNativeBoxResponseBody awaits stream cancel when already aborted', async () => {
  let cancelCalls = 0
  let cancelSettled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([123]))
    },
    cancel() {
      cancelCalls++
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          cancelSettled = true
          resolve()
        }, 5)
      })
    },
  })
  const response = new Response(body, { status: 200 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    readBoundedJevNativeBoxResponseBody(response, controller.signal, 1024),
    /aborted/u,
  )
  assert.equal(cancelCalls, 1)
  assert.ok(cancelSettled)
})

await test('evaluator scores from raw noul+box without trusting producer summaries', () => {
  const scored = scoreJevNativeBoxRow({
    truth: {
      caseId: 'pilot-v03-photo-02',
      sourceCaseId: 'photo-dev-present-06',
      stratum: 'photo',
      presence: 'present',
      imageSha256: 'ad0eb4bf4a6c2c1be585846a943aa06ec2440696b7e8874374904eb25dcc594a',
      sourceWidth: 1024,
      sourceHeight: 683,
      boxes: [
        { left: 354.92624384, top: 225.14823166, width: 350.39528960000007, height: 228.17034274 },
      ],
      referenceMasks: [],
    },
    freezeRow: {
      caseId: 'pilot-v03-photo-02',
      target: 'Bird',
      imagePath: 'benchmarks/cache/v02/corpus/photos/4f05ad23beaefd46.jpg',
      sourceSha256: 'ad0eb4bf4a6c2c1be585846a943aa06ec2440696b7e8874374904eb25dcc594a',
      sourceWidth: 1024,
      sourceHeight: 683,
      preparedImageSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      preparedWidth: 1024,
      preparedHeight: 683,
      sourceImageTransform: {
        source: { width: 1024, height: 683 },
        output: { width: 1024, height: 683 },
        content: { left: 0, top: 0, width: 1024, height: 683 },
        scaleX: 1,
        scaleY: 1,
      },
      requestBodySha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      requestBodyBytes: 100,
      requestPayloadRelativePath: 'payloads/pilot-v03-photo-02.request.json',
      authoredTargetLine: authoredTargetStateLine('Bird'),
      presenceInstructions: JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
      objectInstructions: JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
    },
    runRow: {
      caseId: 'pilot-v03-photo-02',
      status: 'resolved',
      presenceNoul: 0.9,
      rawBox: { left: 0.34, top: 0.32, right: 0.68, bottom: 0.66 },
      responseBodySha256: sha256Bytes(Buffer.from('{}')),
      errorCode: null,
    },
    h8Comparison: {
      h8aBoxGatePass: true,
      h8aFalseOutput: false,
      h8aMaskIoU: null,
      h8SelectedMaskSha256: null,
      h8SelectedMaskRelativePath: null,
      h8MaskSourceWidth: null,
      h8MaskSourceHeight: null,
      h8MaskDerivedBox: null,
      h8InstanceDiagnostics: [],
      h8EvaluationCrossCheckFalseOutput: null,
    },
  })
  assert.equal(scored.rawBoxRetained, true)
  assert.equal(scored.boxGatePass, true)
  assert.equal(scored.derivedPresence, 'present')
})

await test('evaluator rejects uncertain noul as positive box pass', () => {
  const scored = scoreJevNativeBoxRow({
    truth: {
      caseId: 'pilot-v03-photo-01',
      sourceCaseId: 'photo-dev-present-05',
      stratum: 'photo',
      presence: 'present',
      imageSha256: '71b99532e14abb6098a704e9bd9c2c50eebba72588a49e60c8a4b89af4eea4c5',
      sourceWidth: 1024,
      sourceHeight: 683,
      boxes: [{ left: 0, top: 0, width: 10, height: 10 }],
      referenceMasks: [],
    },
    freezeRow: {
      caseId: 'pilot-v03-photo-01',
      target: 'Car',
      imagePath: 'x',
      sourceSha256: '71b99532e14abb6098a704e9bd9c2c50eebba72588a49e60c8a4b89af4eea4c5',
      sourceWidth: 1024,
      sourceHeight: 683,
      preparedImageSha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      preparedWidth: 1024,
      preparedHeight: 683,
      sourceImageTransform: {
        source: { width: 1024, height: 683 },
        output: { width: 1024, height: 683 },
        content: { left: 0, top: 0, width: 1024, height: 683 },
        scaleX: 1,
        scaleY: 1,
      },
      requestBodySha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      requestBodyBytes: 100,
      requestPayloadRelativePath: 'payloads/pilot-v03-photo-01.request.json',
      authoredTargetLine: authoredTargetStateLine('Car'),
      presenceInstructions: JEV_NATIVE_BOX_GENERIC_NOUL_INSTRUCTION,
      objectInstructions: JEV_NATIVE_BOX_GENERIC_BOX_INSTRUCTION,
    },
    runRow: {
      caseId: 'pilot-v03-photo-01',
      status: 'resolved',
      presenceNoul: 0.5,
      rawBox: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 },
      responseBodySha256: sha256Bytes(Buffer.from('{}')),
      errorCode: null,
    },
    h8Comparison: {
      h8aBoxGatePass: false,
      h8aFalseOutput: false,
      h8aMaskIoU: null,
      h8SelectedMaskSha256: null,
      h8SelectedMaskRelativePath: null,
      h8MaskSourceWidth: null,
      h8MaskSourceHeight: null,
      h8MaskDerivedBox: null,
      h8InstanceDiagnostics: [],
      h8EvaluationCrossCheckFalseOutput: null,
    },
  })
  assert.equal(scored.derivedPresence, 'uncertain')
  assert.equal(scored.boxGatePass, false)
})

await test('producer modules do not reference evaluator truth paths', async () => {
  const producerSources = [
    'benchmarks/v03/jev-native-box.ts',
    'benchmarks/v03/run-jev-native-box.ts',
  ]
  for (const relativePath of producerSources) {
    const text = await readFile(join(repositoryRoot, relativePath), 'utf8')
    assert.doesNotMatch(text, /pilot-truth\.json/u)
    assert.doesNotMatch(text, /evaluate-jev-native-box/u)
  }
})

await test('locked manifests preserve DEV12 case order and pinned manifest hashes', async () => {
  const rows = []
  for (const lock of JEV_NATIVE_BOX_MANIFEST_LOCKS) {
    const bytes = await readFile(join(repositoryRoot, lock.path))
    assert.equal(sha256Bytes(bytes), lock.sha256)
    rows.push(...JSON.parse(bytes.toString('utf8')))
  }
  assert.equal(rows.length, 12)
  assert.deepEqual(
    rows.map((row: { caseId: string }) => row.caseId),
    [...JEV_NATIVE_BOX_EXPECTED_CASE_IDS],
  )
})

await test('response parser accepts dated Jev model alias', () => {
  const parsed = parseJevNativeBoxResponse(
    JSON.stringify({
      model: 'typesafe/jev-1.14-20261014',
      provider: 'TypeSafe',
      answers: {
        presence: { type: 'noul', noul: 0.7 },
        object: { type: 'box', box: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } },
      },
    }),
  )
  assert.equal(parsed.answers.object.box.left, 0.1)
})

await test('response envelope keeps usage cost when box schema fails later', () => {
  const raw = JSON.stringify({
    model: 'typesafe/jev-1.14-20261014',
    provider: 'TypeSafe',
    usage: { cost: 0.0012 },
    answers: {
      presence: { type: 'noul', noul: 1.5 },
      object: { type: 'box', box: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } },
    },
  })
  assert.equal(parseJevNativeBoxResponseEnvelope(raw).usageCost, 0.0012)
  assert.throws(() => parseJevNativeBoxResponse(raw))
})

await test('response metadata rejects unexpected provider', () => {
  const parsed = parseJevNativeBoxResponse(
    JSON.stringify({
      model: 'typesafe/jev-1.14-20261014',
      provider: 'OtherProvider',
      answers: {
        presence: { type: 'noul', noul: 0.7, confidence: 0.5 },
        object: {
          type: 'box',
          box: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 },
          confidence: null,
        },
      },
    }),
  )
  assert.throws(() => validateJevNativeBoxResponseMetadata(parsed), /unexpected-response-provider/u)
})

await test('response metadata requires served model and provider route identity', () => {
  const missingModel = parseJevNativeBoxResponse(
    JSON.stringify({
      provider: 'TypeSafe',
      answers: {
        presence: { type: 'noul', noul: 0.7 },
        object: { type: 'box', box: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } },
      },
    }),
  )
  assert.throws(() => validateJevNativeBoxResponseMetadata(missingModel), /missing-response-model/u)
  const missingProvider = parseJevNativeBoxResponse(
    JSON.stringify({
      model: 'typesafe/jev-1.14-20261014',
      answers: {
        presence: { type: 'noul', noul: 0.7 },
        object: { type: 'box', box: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } },
      },
    }),
  )
  assert.throws(
    () => validateJevNativeBoxResponseMetadata(missingProvider),
    /missing-response-provider/u,
  )
})

await test('response metadata rejects invalid normalized box edges before resolve', () => {
  const parsed = parseJevNativeBoxResponse(
    JSON.stringify({
      model: 'typesafe/jev-1.14-20261014',
      provider: 'TypeSafe',
      answers: {
        presence: { type: 'noul', noul: 0.7 },
        object: { type: 'box', box: { left: 0.4, top: 0.2, right: 0.3, bottom: 0.5 } },
      },
    }),
  )
  assert.throws(() => validateJevNativeBoxResponseMetadata(parsed), /unordered/u)
})

await test('response usage envelope preserves OpenRouter token and cost keys', () => {
  const raw = JSON.stringify({
    model: 'typesafe/jev-1.14-20261014',
    provider: 'TypeSafe',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      input_tokens: 100,
      output_tokens: 20,
      cost: 0.0025,
    },
    answers: {
      presence: { type: 'noul', noul: 0.7 },
      object: { type: 'box', box: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } },
    },
  })
  const envelope = parseJevNativeBoxResponseEnvelope(raw)
  assert.equal(envelope.usageCost, 0.0025)
  assert.equal(envelope.model, 'typesafe/jev-1.14-20261014')
  assert.equal(envelope.provider, 'TypeSafe')
  assert.doesNotThrow(() => parseJevNativeBoxResponse(raw))
})
