import { ClassifierError, assertActive } from '../../entities/errors.js'
import type { PixelRect } from '../../entities/contracts.js'
import type {
  ObjectProposalPresentationPort,
  PackedBinaryMask,
  PresentedObjectProposal,
} from '../../entities/object-proposals.js'
import { objectProposalLimits } from '../../entities/object-proposals.js'
import type { RgbaRaster } from '../../entities/representation.js'
import { unpackBinaryMask } from '../../features/segmentation/packed-mask.js'
import { maskBounds } from './proposal-presentation-pixels.js'

type ProposalSnapshot = {
  id: string
  data: Uint8Array
  region: PixelRect | null
  bounds: PixelRect | null
}

export function assertProposalSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw proposalInvalid('signal must be an AbortSignal')
  assertActive(signal)
}

function assertProposalImage(image: RgbaRaster): void {
  if (
    image.format !== 'rgba8' ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width * image.height > objectProposalLimits.imagePixels ||
    image.data.length !== image.width * image.height * 4
  )
    throw proposalInvalid('Expected canonical RGBA image within proposal limits')
}

function assertProposalRect(rect: PixelRect, width: number, height: number, name: string): void {
  if (
    !rect ||
    !Number.isSafeInteger(rect.left) ||
    !Number.isSafeInteger(rect.top) ||
    !Number.isSafeInteger(rect.width) ||
    !Number.isSafeInteger(rect.height) ||
    rect.left < 0 ||
    rect.top < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.left + rect.width > width ||
    rect.top + rect.height > height
  )
    throw proposalInvalid(`${name} is outside the source image`)
}

type PresentationRenderInput = Parameters<ObjectProposalPresentationPort['render']>[0]

export function snapshotOwnedPresentationInput(input: PresentationRenderInput): {
  source: Uint8Array
  image: RgbaRaster
  seedRegion: PixelRect
  snapshots: ProposalSnapshot[]
} {
  const callerImage = input.image
  assertProposalImage(callerImage)
  const callerSeedRegion = input.seedRegion
  assertProposalRect(callerSeedRegion, callerImage.width, callerImage.height, 'seedRegion')
  const image: RgbaRaster = {
    data: new Uint8Array(callerImage.data),
    width: callerImage.width,
    height: callerImage.height,
    format: callerImage.format,
  }
  const seedRegion = { ...callerSeedRegion }
  const proposals = input.proposals
  if (
    !Array.isArray(proposals) ||
    proposals.length < 1 ||
    proposals.length > objectProposalLimits.candidates
  )
    throw proposalInvalid('Expected 1..36 object proposals')

  const source = image.data
  let previousAlias = -1
  for (const proposal of proposals) {
    const match = typeof proposal.id === 'string' ? /^C(\d{2})$/.exec(proposal.id) : null
    const alias = match ? Number(match[1]) : -1
    if (alias < 0 || alias >= objectProposalLimits.candidates || alias <= previousAlias)
      throw proposalInvalid('Proposal aliases must be unique and retain source order')
    previousAlias = alias
  }
  const snapshots = proposals.map((proposal) => snapshotProposal(proposal, image))
  if (
    snapshots.reduce((sum, item) => sum + item.data.byteLength, 0) >
    objectProposalLimits.packedBytes
  )
    throw proposalInvalid('Packed proposal data exceeds the byte limit')
  return { source, image, seedRegion, snapshots }
}

function snapshotProposal(proposal: PresentedObjectProposal, image: RgbaRaster): ProposalSnapshot {
  const id = proposal.id
  const mask: PackedBinaryMask = proposal.mask
  const expectedBytes = Math.ceil((image.width * image.height) / 8)
  if (
    !/^C(?:0[0-9]|[12][0-9]|3[0-5])$/.test(id) ||
    !mask ||
    mask.format !== 'binary-lsb0' ||
    mask.width !== image.width ||
    mask.height !== image.height ||
    !(mask.data instanceof Uint8Array) ||
    mask.data.byteLength !== expectedBytes
  )
    throw proposalInvalid('Object proposal aliases or packed mask dimensions are invalid')
  const data = new Uint8Array(mask.data)
  const decoded = unpackBinaryMask({
    data,
    width: image.width,
    height: image.height,
    format: 'binary-lsb0',
  })
  const bounds = maskBounds(decoded, image.width, image.height)
  if (bounds === null) {
    if (proposal.region !== null)
      throw proposalInvalid('Empty proposal must have a null pixel region')
  } else if (proposal.region !== null) {
    assertProposalRect(proposal.region, image.width, image.height, 'proposal region')
    if (
      proposal.region.left !== bounds.left ||
      proposal.region.top !== bounds.top ||
      proposal.region.width !== bounds.width ||
      proposal.region.height !== bounds.height
    )
      throw proposalInvalid('Proposal region does not match packed mask support')
  }
  return {
    id,
    data,
    region: bounds ? { ...bounds } : null,
    bounds: bounds ? { ...bounds } : null,
  }
}

export function proposalInvalid(message: string): ClassifierError {
  return new ClassifierError('INVALID_RESPONSE', message)
}
