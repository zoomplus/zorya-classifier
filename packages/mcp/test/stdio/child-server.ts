import type { DecisionPort } from 'zorya-classifier'

import { createCoreApplication } from '../../src/core/application.js'
import { McpCoreError } from '../../src/errors.js'
import { startStdioServer } from '../../src/stdio/server.js'

const decisionPort: DecisionPort = {
  async decide() {
    throw new McpCoreError('UNSUPPORTED_OPERATION', 'The stdio fixture does not call providers.')
  },
}

const application = createCoreApplication({
  config: {
    profiles: {
      fixture: {
        id: 'fixture',
        adapter: 'injected-decision',
        credentialMode: 'none',
      },
    },
    defaultProfileId: 'fixture',
  },
  mediaPort: {
    async loadImage() {
      throw new McpCoreError('MEDIA_UNAVAILABLE', 'The stdio fixture has no media source.')
    },
  },
  artifactPort: {
    async put() {
      throw new McpCoreError('ARTIFACT_UNAVAILABLE', 'The stdio fixture stores no artifacts.')
    },
    async read() {
      throw new McpCoreError('NOT_FOUND', 'The stdio fixture has no artifacts.')
    },
    async deleteJob() {},
    async deleteOwner() {},
  },
  injectedDecisionPorts: { fixture: decisionPort },
})

startStdioServer(application, { ownerId: 'stdio-fixture-owner', legacy: 'serve' })
process.stderr.write('MCP_READY\n')
