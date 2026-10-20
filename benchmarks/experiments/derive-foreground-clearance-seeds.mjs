import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'

const inputPath = resolve(process.argv[2] ?? 'benchmarks/v02/native-dev-photo-fixtures.json')
const outputPath = resolve(
  process.argv[3] ?? '.run/v02/paired-components-c63da6/corrected-foreground-seeds.json',
)
const inputBytes = await readFile(inputPath)
const fixtures = JSON.parse(inputBytes.toString('utf8'))
const derivations = []
const corrected = []

for (const fixture of fixtures) {
  if (!fixture.referenceMaskPath || fixture.referenceMaskFormat !== 'png-binary')
    throw new Error(`Expected a PNG binary reference mask for ${fixture.id}`)
  const maskPath = resolve(dirname(inputPath), fixture.referenceMaskPath)
  const maskBytes = await readFile(maskPath)
  const maskSha256 = createHash('sha256').update(maskBytes).digest('hex')
  if (maskSha256 !== fixture.referenceMaskSha256)
    throw new Error(`Reference mask SHA256 mismatch for ${fixture.id}`)
  const decoded = await sharp(maskBytes, { limitInputPixels: 16_777_216, failOn: 'error' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const imageBytes = await readFile(resolve(dirname(inputPath), fixture.imagePath))
  if (createHash('sha256').update(imageBytes).digest('hex') !== fixture.sha256)
    throw new Error(`Source image SHA256 mismatch for ${fixture.id}`)
  const image = await sharp(imageBytes, { limitInputPixels: 16_777_216, failOn: 'error' })
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (decoded.info.width !== image.info.width || decoded.info.height !== image.info.height)
    throw new Error(`Image and reference-mask dimensions differ for ${fixture.id}`)

  const { width, height } = decoded.info
  const distance = new Uint32Array(width * height)
  let foregroundPixels = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const value = decoded.data[index]
      if (value !== 0 && value !== 255)
        throw new Error(`Reference mask is not binary for ${fixture.id}`)
      if (value === 255) {
        foregroundPixels++
        distance[index] = Math.min(x + 1, y + 1, width - x, height - y)
      }
    }
  }
  if (foregroundPixels === 0) throw new Error(`Reference mask has no foreground for ${fixture.id}`)

  // Two raster passes compute exact 4-neighbor Manhattan clearance to the
  // nearest background pixel (including the image exterior). Ties keep the
  // first row-major foreground pixel.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (decoded.data[index] !== 255) continue
      if (x > 0) distance[index] = Math.min(distance[index], distance[index - 1] + 1)
      if (y > 0) distance[index] = Math.min(distance[index], distance[index - width] + 1)
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x
      if (decoded.data[index] !== 255) continue
      if (x + 1 < width) distance[index] = Math.min(distance[index], distance[index + 1] + 1)
      if (y + 1 < height) distance[index] = Math.min(distance[index], distance[index + width] + 1)
    }
  }

  let bestIndex = -1
  let bestClearance = -1
  for (let index = 0; index < distance.length; index++) {
    if (decoded.data[index] === 255 && distance[index] > bestClearance) {
      bestIndex = index
      bestClearance = distance[index]
    }
  }
  const x = bestIndex % width
  const y = Math.floor(bestIndex / width)
  const requestedPatchSize = 11
  const patchSize = Math.min(
    requestedPatchSize,
    2 * Math.min(x, width - 1 - x, y, height - 1 - y) + 1,
  )
  if (patchSize < 1 || patchSize % 2 === 0)
    throw new Error(`Could not center an odd seed patch on the selected pixel for ${fixture.id}`)
  const half = Math.floor(patchSize / 2)
  const seedRegion = { left: x - half, top: y - half, width: patchSize, height: patchSize }
  const selectedPixelIsForeground = decoded.data[y * width + x] === 255
  if (!selectedPixelIsForeground)
    throw new Error(`Selected seed center is outside the reference mask for ${fixture.id}`)

  corrected.push({
    ...fixture,
    imagePath: relative(dirname(outputPath), resolve(dirname(inputPath), fixture.imagePath))
      .split(sep)
      .join('/'),
    referenceMaskPath: relative(dirname(outputPath), maskPath).split(sep).join('/'),
    seedRegion,
  })
  derivations.push({
    id: fixture.id,
    target: fixture.target,
    imageSha256: fixture.sha256,
    referenceMaskSha256: maskSha256,
    originalSeedRegion: fixture.seedRegion,
    originalSeedForegroundPixels: countMaskInRect(decoded.data, width, fixture.seedRegion),
    selectedPixel: { x, y },
    clearanceL1Pixels: bestClearance,
    seedRegion,
    seedCenterIsForeground: selectedPixelIsForeground,
    gtForegroundPixelCount: foregroundPixels,
  })
}

const outputBytes = Buffer.from(`${JSON.stringify(corrected, null, 2)}\n`)
await writeFile(outputPath, outputBytes, { flag: 'wx' })
const derivationPath = outputPath.replace(/\.json$/, '.derivation.json')
await writeFile(
  derivationPath,
  `${JSON.stringify(
    {
      method:
        'Exact 4-neighbor Manhattan distance transform to reference-mask background; choose first row-major foreground pixel with maximum clearance. Center an odd square seed patch on that pixel, capped at 11x11 and clipped only by shrinking to an odd size.',
      fixtureManifestSha256: createHash('sha256').update(inputBytes).digest('hex'),
      correctedManifestSha256: createHash('sha256').update(outputBytes).digest('hex'),
      cases: derivations,
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
)
console.log(
  JSON.stringify(
    {
      correctedManifestPath: outputPath,
      derivationPath,
      correctedManifestSha256: createHash('sha256').update(outputBytes).digest('hex'),
      cases: derivations,
    },
    null,
    2,
  ),
)

function countMaskInRect(mask, width, rect) {
  let count = 0
  for (let y = rect.top; y < rect.top + rect.height; y++)
    for (let x = rect.left; x < rect.left + rect.width; x++)
      if (mask[y * width + x] === 255) count++
  return count
}
