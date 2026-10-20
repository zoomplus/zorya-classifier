import assert from 'node:assert/strict'
import test from 'node:test'
import { copyAuthoredFreshCase } from '../benchmarks/v02/derive-heldout-inputs.js'

function guarded<T extends Record<string, unknown>>(value: T, forbidden: ReadonlySet<string>): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === 'string' && forbidden.has(property))
        throw new Error(`Forbidden oracle field accessed: ${property}`)
      return Reflect.get(target, property, receiver) as T[keyof T]
    },
  })
}

await test('heldout input derivation copies only authored producer fields', () => {
  const forbidden = new Set([
    'truth',
    'expectedPresence',
    'targetBoxes',
    'referenceMasks',
    'bbox',
    'geometry',
    'negativeEvidence',
  ])
  const source = guarded(
    {
      caseId: 'source-01',
      image: guarded(
        {
          path: '/unused/source/path.png',
          sha256: 'a'.repeat(64),
          width: 640,
          height: 480,
          referenceMasks: [],
        },
        forbidden,
      ),
      locate: guarded(
        { target: 'the visible object', instruction: 'Find the whole object.' },
        forbidden,
      ),
      classify: guarded(
        { question: 'Is the object visible?', options: ['present', 'absent'] },
        forbidden,
      ),
      expectedPresence: 'present',
      truth: { targetBoxes: [{ xyxy: [0, 0, 1, 1] }] },
    },
    forbidden,
  )

  assert.deepEqual(copyAuthoredFreshCase(source, 'source/source-01.png'), {
    caseId: 'source-01',
    image: {
      path: 'source/source-01.png',
      sha256: 'a'.repeat(64),
      width: 640,
      height: 480,
    },
    locate: { target: 'the visible object', instruction: 'Find the whole object.' },
    classify: { question: 'Is the object visible?', options: ['present', 'absent'] },
  })
})

await test('heldout input derivation fails closed when no authored target exists', () => {
  const source = {
    caseId: 'ui-01',
    image: { sha256: 'b'.repeat(64), width: 640, height: 480 },
    locate: {},
    classify: { options: ['present', 'absent'] },
  }
  assert.throws(
    () => copyAuthoredFreshCase(source, 'ui/case-01.png'),
    /locate\.target must be a nonempty string/u,
  )
})
