import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import test from 'node:test'

const sourceTree = process.env.ZORYA_HISTORIC_V02_SOURCE_TREE
const receiptPath = process.env.ZORYA_HISTORIC_V02_SNAPSHOT_RECEIPT

await test(
  'restored historic v0.2 control kernel, decision adapter, and injected segmentation run with fake fetch',
  { skip: !sourceTree || !receiptPath },
  async () => {
    const receiptBytes = await readFile(receiptPath)
    const receiptSha256 = createHash('sha256').update(receiptBytes).digest('hex')
    assert.equal(receiptSha256, '0422a3e62925bb33f4fe41480d6554887ae9c888681125f8b8522d9174361f71')
    const receipt = JSON.parse(receiptBytes.toString('utf8'))
    assert.equal(
      receipt.sourceClosureIdentityFromFreeze,
      'be43090b13951e9a6ffa65daffb9413a6a539d8dae335925dc885733a467fb20',
    )

    const archivedModule = async (relativePath) =>
      import(pathToFileURL(join(sourceTree, relativePath)).href)
    const [kernel, classifierModule, decisionsModule, categoricalModule] = await Promise.all([
      archivedModule('benchmarks/v02/region-seeded-runner.ts'),
      archivedModule('src/app/create-classifier.ts'),
      archivedModule('src/infrastructure/openrouter.ts'),
      archivedModule('benchmarks/v02/native-categorical-presence-port.ts'),
    ])
    const [runtimeModule, constants, ledgerModule] = await Promise.all([
      import('./runtime-ports.ts'),
      import('./constants.ts'),
      import('./campaign-ledger.ts'),
    ])

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'h8a-historic-smoke-'))
    const sourceBytes = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 4,
        background: { r: 60, g: 90, b: 120, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    const counters = { kernel: 0, classifier: 0, decision: 0, wrapper: 0, segmentation: 0 }
    const segmenter = {
      async segment(input) {
        counters.segmentation++
        const width = input.image.width
        const height = input.image.height
        return {
          status: 'segmented',
          mask: {
            format: 'binary-u8',
            width,
            height,
            data: new Uint8Array(width * height).fill(1),
          },
          metadata: {
            method: 'historic-smoke-stub',
            backend: 'mobile-sam',
            durationMs: 1,
            input: { width, height },
          },
        }
      },
      async settle() {},
      async dispose() {},
    }
    const fakeFetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const answers = Object.fromEntries(
        Object.entries(request.questions ?? {}).map(([id, question]) => {
          const criteria = Object.keys(question.criteria ?? {})
          const choice = criteria.includes('present')
            ? 'present'
            : criteria.includes('complete')
              ? 'complete'
              : criteria[0]
          return [
            id,
            {
              type: 'choice',
              choice,
              probabilities: Object.fromEntries(
                criteria.map((key) => [key, key === choice ? 1 : 0]),
              ),
            },
          ]
        }),
      )
      return new globalThis.Response(
        JSON.stringify({
          id: 'historic-smoke-response',
          model: 'openai/gpt-6-luna-decisions',
          provider: 'OpenAI',
          answers,
          usage: { cost: 0.001 },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }
    let runtime
    try {
      runtime = await runtimeModule.createH8FreshRuntimePorts({
        apiKey: 'test',
        artifactRoot: join(temporaryRoot, 'artifacts'),
        temporaryRoot: join(temporaryRoot, 'case-temp'),
        maskArtifactDirectory: join(temporaryRoot, 'masks'),
        cutoutArtifactDirectory: join(temporaryRoot, 'cutouts'),
        nativeRuntime: {
          pythonExecutable: 'unused-smoke-value',
          assetRoot: join(temporaryRoot, 'unused-assets'),
        },
        mobileSam: {
          encoderPath: join(temporaryRoot, 'unused-encoder.onnx'),
          decoderPath: join(temporaryRoot, 'unused-decoder.onnx'),
        },
        sourceCanvasByOpaqueCaseId: new Map([['opaque-historic-smoke', { width: 64, height: 48 }]]),
        fetch: fakeFetch,
        createCandidateRuntime: () => ({
          async run() {
            return { status: 'unknown', reason: 'unused' }
          },
          async dispose() {},
        }),
        controlEngine: {
          kind: 'verified-historical-v02',
          sourceClosureSha256: receipt.sourceClosureIdentityFromFreeze,
          snapshotReceiptSha256: receiptSha256,
          processRegionSeededCase(args) {
            counters.kernel++
            return kernel.processRegionSeededCase(args)
          },
          assertRecorderHealthy: kernel.assertRecorderHealthy,
          createClassifier(options) {
            counters.classifier++
            return classifierModule.createClassifier(options)
          },
          createOpenRouterDecisions(options) {
            counters.decision++
            return decisionsModule.createOpenRouterDecisions(options)
          },
          createNativeCategoricalPresencePort(nativePort) {
            counters.wrapper++
            return categoricalModule.createNativeCategoricalPresencePort(nativePort)
          },
          async createMobileSamSegmenter() {
            return segmenter
          },
        },
      })
      const ledger = await ledgerModule.CampaignLedger.open(join(temporaryRoot, 'ledger.json'))
      const result = await runtime.controlPort.execute(
        {
          opaqueCaseId: 'opaque-historic-smoke',
          sourceBytes,
          targetTaskText: 'a visible vehicle',
        },
        {
          profileId: constants.PROFILE_CONTROL_ID,
          reservedUsdPerFetch: 0.12,
          ledger,
        },
      )
      assert.equal(result.outputRow.opaqueCaseId, 'opaque-historic-smoke')
      assert.equal(counters.kernel, 1)
      assert.equal(counters.classifier, 1)
      assert.equal(counters.decision, 1)
      assert.equal(counters.wrapper, 1)
      assert.ok(counters.segmentation >= 1)
      assert.ok(runtime.fetchJournal.length >= 1)
      assert.ok(runtime.fetchJournal.every((entry) => entry.endpoint === '/api/alpha/decisions'))
    } finally {
      await runtime?.dispose()
      await rm(temporaryRoot, { recursive: true, force: false })
    }
  },
)
