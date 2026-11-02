import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const packageEntry = process.argv[2]
const libraryEntry = process.argv[3]
if (!packageEntry || !libraryEntry) throw new Error('Fixture package entry paths are required.')

const api = await import(pathToFileURL(resolve(packageEntry)).href)
const library = await import(pathToFileURL(resolve(libraryEntry)).href)
const artifactStore = api.createPrivateArtifactStore({
  maxGlobalBytes: 8 * 1024 * 1024,
  maxOwnerBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
  maxArtifacts: 64,
  maxArtifactsPerOwner: 32,
  ttlMs: 60_000,
})
const decisionPort = createDecisionPort()
const segmenter = createSegmenter()
const application = api.createCoreApplication({
  config: fixtureConfig(),
  mediaPort: api.createMediaPort({ remote: { trustedHosts: [] }, maxPixels: 1024 }),
  artifactPort: artifactStore,
  classifierFactory: fixtureClassifierFactory(library, segmenter),
  injectedDecisionPorts: { fixture: decisionPort },
  mediaCapabilities: { remote: false, uploads: false },
})
const stdio = api.startStdioServer(application, {
  ownerId: 'consumer-stdio-owner',
  legacy: 'serve',
})
let shutdown = Promise.resolve()
process.stdin.once('end', () => {
  shutdown = (async () => {
    await stdio.close()
    await segmenter.settle()
    await segmenter.dispose()
    await artifactStore.dispose()
  })()
})
await new Promise((resolveShutdown) => {
  process.stdin.once('end', resolveShutdown)
})
await shutdown

function fixtureConfig() {
  return {
    profiles: {
      fixture: { id: 'fixture', adapter: 'injected-decision', credentialMode: 'none' },
    },
    defaultProfileId: 'fixture',
    // Core requires declared segmentation support; the injected fixture port never opens this marker path.
    segmentation: { kind: 'grabcut', assetPath: 'offline-fixture-asset-not-opened.xml' },
    limits: {
      maxImageBytes: 1_048_576,
      maxImagePixels: 1024,
      maxQueuedJobs: 16,
      maxQueuedJobsPerOwner: 8,
      maxStoredJobs: 64,
      maxStoredJobsPerOwner: 32,
      maxQueuedInputBytes: 8 * 1024 * 1024,
      maxQueuedInputBytesPerOwner: 4 * 1024 * 1024,
      maxActiveJobs: 1,
      maxActiveJobsPerOwner: 1,
      jobTimeoutMs: 30_000,
      jobTtlMs: 60_000,
      artifactTtlMs: 60_000,
      maxArtifactBytes: 4 * 1024 * 1024,
      maxArtifactTotalBytes: 8 * 1024 * 1024,
      maxArtifactTotalBytesPerOwner: 8 * 1024 * 1024,
      maxResultJsonBytes: 1_048_576,
    },
  }
}

function fixtureClassifierFactory({ createClassifier }, segmentation) {
  return {
    async create(input) {
      if (!('decisionPort' in input))
        throw new Error('Fixture requires the injected DecisionPort route.')
      const classifier = createClassifier({ decision: input.decisionPort, segmentation })
      return {
        classifier,
        segmenter: segmentation,
        async dispose() {
          await classifier.dispose()
        },
      }
    },
  }
}

function createDecisionPort() {
  return {
    async decide(request) {
      if (
        request.state.some((part) => typeof part === 'string' && part.includes('consumer-hold'))
      ) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
      }
      const answers = {}
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === 'choice') {
          const ids = Object.keys(question.criteria)
          const choice = ids[0]
          if (choice === undefined) throw new Error('Fixture choice set is empty.')
          answers[key] = {
            type: 'choice',
            choice,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
          }
        } else answers[key] = { type: 'noul', noul: 0.95 }
      }
      return {
        answers,
        metadata: {
          model: null,
          provider: null,
          requestId: 'offline-fixture',
          durationMs: 0,
          costUsd: null,
          attempts: 1,
        },
      }
    },
  }
}

function createSegmenter() {
  let disposed = false
  return {
    async segment(input) {
      if (disposed) throw new Error('Fixture segmenter is disposed.')
      const { width, height } = input.image
      const data = new Uint8Array(width * height)
      for (let offset = 2; offset <= 6; offset++) {
        data[2 * width + offset] = 1
        data[offset * width + 2] = 1
      }
      return {
        status: 'segmented',
        mask: {
          data,
          width,
          height,
          format: 'binary-u8',
        },
        metadata: {
          method: 'consumer-fixture',
          backend: 'offline',
          durationMs: 0,
          input: { width, height },
        },
      }
    },
    async settle() {},
    async dispose() {
      disposed = true
    },
  }
}
