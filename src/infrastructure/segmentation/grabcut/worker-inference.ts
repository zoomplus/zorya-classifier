import type { NativeSegmentationReply, NativeSegmentationRequest } from '../native-protocol.js'
import {
  getBytes,
  initializeGrabCutMask,
  runGrabCutAndCopyMask,
  seededComponents,
} from './masks.js'
import { loadOpenCv, matrix, probeGrabCut } from './runtime.js'

export { initializeGrabCutMask, runGrabCutAndCopyMask }
export { probeGrabCut }

export async function runGrabCutTask(
  request: Extract<NativeSegmentationRequest, { kind: 'grabcut' }>,
): Promise<NativeSegmentationReply> {
  const cv = await loadOpenCv(request.assetPath)
  const pixels = request.width * request.height
  const rgbaBytes = Buffer.from(request.rgba, 'base64')
  if (rgbaBytes.length !== pixels * 4) throw new Error('Invalid GrabCut RGBA bytes')
  const rgba = matrix(cv, [request.height, request.width, cv.CV_8UC4])
  const rgb = matrix(cv)
  const mask = matrix(cv, [request.height, request.width, cv.CV_8UC1])
  const background = matrix(cv)
  const foreground = matrix(cv)
  const owned = [rgba, rgb, mask, background, foreground]
  let result: NativeSegmentationReply | undefined
  let releaseFailed = false
  try {
    getBytes(rgba, pixels * 4).set(rgbaBytes)
    Reflect.apply(cv.cvtColor, cv, [rgba, rgb, cv.COLOR_RGBA2RGB])
    const flags = getBytes(mask, pixels)
    initializeGrabCutMask({
      flags,
      width: request.width,
      height: request.height,
      seedRegion: request.seedRegion,
      wholeRegion: request.wholeRegion,
      roi: request.roi,
      prompt: request.prompt,
      labels: {
        background: cv.GC_BGD,
        foreground: cv.GC_FGD,
        probableBackground: cv.GC_PR_BGD,
        probableForeground: cv.GC_PR_FGD,
      },
    })
    const rect = Reflect.construct(cv.Rect, [0, 0, 0, 0])
    const maskResult = runGrabCutAndCopyMask(
      mask,
      request.width,
      request.height,
      request.roi,
      () =>
        Reflect.apply(cv.grabCut, cv, [
          rgb,
          mask,
          rect,
          background,
          foreground,
          3,
          cv.GC_INIT_WITH_MASK,
        ]),
      { foreground: cv.GC_FGD, probableForeground: cv.GC_PR_FGD },
    )
    const grounded = seededComponents(maskResult, request.width, request.height, request)
    if (!grounded.some((value) => value === 1))
      throw new Error('GrabCut produced no seed-grounded mask')
    result = {
      id: request.id,
      status: 'segmented',
      width: request.width,
      height: request.height,
      mask: Buffer.from(grounded).toString('base64'),
      method: request.prompt === 'seed-region' ? 'grabcut-seed-mask-v1' : 'grabcut-seeded-box-v1',
    }
  } finally {
    let failed = false
    for (const item of owned.reverse()) {
      try {
        item.delete()
      } catch {
        failed = true
      }
    }
    releaseFailed = failed
  }
  if (releaseFailed) throw new Error('OpenCV matrices could not all be released')
  if (!result) throw new Error('GrabCut completed without a mask result')
  return result
}
