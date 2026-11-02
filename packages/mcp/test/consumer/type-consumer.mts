import {
  createCoreApplication,
  parseMcpConfig,
  PublishedClassifierFactory,
} from 'zorya-classifier-mcp'
import type { CoreApplicationOptions, McpConfigInput } from 'zorya-classifier-mcp'
import { createClassifier } from 'zorya-classifier'
import type { DecisionPort } from 'zorya-classifier'
import type { SegmentationPort } from 'zorya-classifier/segmentation'

const configuration: McpConfigInput = {
  profiles: {
    fixture: { id: 'fixture', adapter: 'injected-decision', credentialMode: 'none' },
  },
  defaultProfileId: 'fixture',
}
const parsedConfiguration = parseMcpConfig(configuration)
new PublishedClassifierFactory(parsedConfiguration)

const decision: DecisionPort = {
  async decide() {
    throw new Error('Type-only consumer example is never executed.')
  },
}
const segmentation: SegmentationPort = {
  async segment() {
    throw new Error('Type-only consumer example is never executed.')
  },
  async settle() {},
  async dispose() {},
}
createClassifier({ decision, segmentation })

declare const options: CoreApplicationOptions
createCoreApplication(options)
