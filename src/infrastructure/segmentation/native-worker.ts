import { nativeSegmentationRequestSchema } from './native-protocol.js'
import { ClassifierError, type ErrorCode } from '../../entities/errors.js'
import { probeMobileSam, runMobileSamTask } from './mobile-sam/worker-inference.js'
import { probeGrabCut, runGrabCutTask } from './grabcut/worker-inference.js'

const stopOnParentLoss = () => {
  process.exit(1)
}
let telemetryTimer: NodeJS.Timeout | undefined
process.on('disconnect', stopOnParentLoss)
process.on('message', (message: unknown) => {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'telemetry' ||
    !('enabled' in message)
  )
    return
  if (message.enabled === true && !telemetryTimer) {
    sendMemory()
    telemetryTimer = setInterval(
      () => process.send?.({ type: 'memory', memory: process.memoryUsage() }),
      1000,
    )
    telemetryTimer.unref()
  } else if (message.enabled === false && telemetryTimer) {
    clearInterval(telemetryTimer)
    telemetryTimer = undefined
  }
})
process.send?.({ type: 'ready' })

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const request = nativeSegmentationRequestSchema.parse(raw)
  activeId = request.id
  const reply =
    request.kind === 'mobile-sam'
      ? await runMobileSamTask(request)
      : request.kind === 'grabcut'
        ? await runGrabCutTask(request)
        : request.kind === 'probe-mobile-sam'
          ? await probeMobileSam(request.options).then(() => ({
              id: request.id,
              status: 'ready',
              backend: 'mobile-sam',
            }))
          : await probeGrabCut(request.assetPath).then(() => ({
              id: request.id,
              status: 'ready',
              backend: 'grabcut',
            }))
  sendMemory()
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(reply), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  if (telemetryTimer) clearInterval(telemetryTimer)
  process.off('disconnect', stopOnParentLoss)
  process.disconnect()
}

main().catch(async (error: unknown) => {
  const safe = classifyFailure(error)
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify({ id: activeId, status: 'error', ...safe }), () =>
      resolve(),
    )
  })
  if (telemetryTimer) clearInterval(telemetryTimer)
  process.off('disconnect', stopOnParentLoss)
  process.disconnect()
})

let activeId = ''
function sendMemory(): void {
  process.send?.({ type: 'memory', memory: process.memoryUsage() })
}
function classifyFailure(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof ClassifierError)
    return { code: error.code, message: error.message.slice(0, 300) }
  const message = error instanceof Error ? error.message : 'Native segmentation failed'
  if (
    /unavailable|not supported|not found|cannot find|module|pinned|asset|execution provider/i.test(
      message,
    )
  )
    return { code: 'UNSUPPORTED', message: 'Required native backend or asset is unavailable' }
  if (/limit|too large|queue full/i.test(message))
    return { code: 'RESOURCE_LIMIT', message: 'Native segmentation exceeded a resource limit' }
  if (/invalid|unexpected|mismatch|incompatible|non-finite/i.test(message))
    return { code: 'INVALID_RESPONSE', message: 'Native backend returned invalid data' }
  return { code: 'PROVIDER', message: 'Native segmentation backend failed' }
}
