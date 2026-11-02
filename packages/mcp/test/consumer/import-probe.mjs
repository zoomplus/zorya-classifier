import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

const entryPath = process.argv[2]
const cliPath = process.argv[3]
if (entryPath === undefined || cliPath === undefined)
  throw new Error('Installed package and CLI entry paths are required.')

const originalFetch = globalThis.fetch
const originalSpawn = childProcess.spawn
const originalExec = childProcess.exec
const originalExecFile = childProcess.execFile
const originalFork = childProcess.fork
const originalSpawnSync = childProcess.spawnSync
const originalExecSync = childProcess.execSync
const originalExecFileSync = childProcess.execFileSync
const originalHttpRequest = http.request
const originalHttpGet = http.get
const originalHttpsRequest = https.request
const originalHttpsGet = https.get
const originalNetConnect = net.connect
const originalNetCreateConnection = net.createConnection
const originalTlsConnect = tls.connect
const blocked = () => {
  throw new Error('Import attempted network or child-process work.')
}
globalThis.fetch = blocked
childProcess.spawn = blocked
childProcess.exec = blocked
childProcess.execFile = blocked
childProcess.fork = blocked
childProcess.spawnSync = blocked
childProcess.execSync = blocked
childProcess.execFileSync = blocked
http.request = blocked
http.get = blocked
https.request = blocked
https.get = blocked
net.connect = blocked
net.createConnection = blocked
tls.connect = blocked
syncBuiltinESMExports()
const stableResources = () =>
  process
    .getActiveResourcesInfo()
    .filter((resource) => resource !== 'PipeWrap')
    .sort()
const before = stableResources()
try {
  await import(pathToFileURL(entryPath).href)
  await import(pathToFileURL(cliPath).href)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(stableResources(), before)
  process.stdout.write('import-inert\n')
} finally {
  globalThis.fetch = originalFetch
  childProcess.spawn = originalSpawn
  childProcess.exec = originalExec
  childProcess.execFile = originalExecFile
  childProcess.fork = originalFork
  childProcess.spawnSync = originalSpawnSync
  childProcess.execSync = originalExecSync
  childProcess.execFileSync = originalExecFileSync
  http.request = originalHttpRequest
  http.get = originalHttpGet
  https.request = originalHttpsRequest
  https.get = originalHttpsGet
  net.connect = originalNetConnect
  net.createConnection = originalNetCreateConnection
  tls.connect = originalTlsConnect
  syncBuiltinESMExports()
}
