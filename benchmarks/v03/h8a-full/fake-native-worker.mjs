import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, symlink, writeFile, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers'
import { dirname, join } from 'node:path'

const NATIVE_RESPONSE_SCHEMA = 'h8a-full-native-response-v1'
const NATIVE_REQUEST_SCHEMA = 'h8a-full-native-request-v1'
const RECIPE_ID = 'h8a-cpu-raw-target-v1'

function sha256Bytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

function packRect(width, height, rect) {
  const [left, top, rw, rh] = rect
  const pixels = width * height
  const data = Buffer.alloc(Math.ceil(pixels / 8))
  if (rw > 0 && rh > 0) {
    for (let y = top; y < top + rh; y++) {
      for (let x = left; x < left + rw; x++) {
        const index = y * width + x
        data[index >> 3] |= 1 << (index & 7)
      }
    }
  }
  const unused = data.length * 8 - pixels
  if (unused > 0) {
    const mask = (1 << (8 - unused)) - 1
    if ((data[data.length - 1] & ~mask) !== 0) throw new Error('padding bits')
  }
  return data
}

function validateRequest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('request must be object')
  if (raw.schema !== NATIVE_REQUEST_SCHEMA) throw new Error('schema mismatch')
  if (typeof raw.request_id !== 'string' || raw.request_id.length !== 36)
    throw new Error('request_id')
  if (raw.recipe_id !== RECIPE_ID) throw new Error('recipe_id')
  if (typeof raw.authored_target !== 'string' || !raw.authored_target)
    throw new Error('authored_target')
  if (typeof raw.task_dir !== 'string') throw new Error('task_dir')
  if (typeof raw.source_path !== 'string') throw new Error('source_path')
  if (typeof raw.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.source_sha256))
    throw new Error('source_sha256')
  if (!Number.isInteger(raw.width) || raw.width <= 0) throw new Error('width')
  if (!Number.isInteger(raw.height) || raw.height <= 0) throw new Error('height')
  return raw
}

function identityFromRequest(payload) {
  return {
    request_id: payload.request_id,
    recipe_id: payload.recipe_id,
    source_sha256: payload.source_sha256,
  }
}

async function writeJsonAtomic(path, value) {
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(temp, path)
}

async function runOrphanPipe() {
  const helper = `
import os, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
r, w = os.pipe()
if os.fork() == 0:
  os.close(w)
  time.sleep(60)
  os._exit(0)
os.close(r)
time.sleep(0.2)
print('{"schema":"${NATIVE_RESPONSE_SCHEMA}","status":"complete"}')
`
  const child = spawn('python3', ['-c', helper], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.unref()
  await new Promise((resolve) => setTimeout(resolve, 300))
  process.stdout.write(
    JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'complete' }) + '\n',
  )
  return 0
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    process.stdout.write(JSON.stringify({ status: 'self_test_ok', device: 'fake' }) + '\n')
    return 0
  }
  if (args.includes('--validate-request')) {
    const index = args.indexOf('--validate-request')
    const path = args[index + 1]
    validateRequest(JSON.parse(await readFile(path, 'utf8')))
    process.stdout.write(JSON.stringify({ status: 'valid' }) + '\n')
    return 0
  }
  if (!args.includes('--generate')) return 2
  const index = args.indexOf('--generate')
  const requestPath = args[index + 1]
  const payload = validateRequest(JSON.parse(await readFile(requestPath, 'utf8')))
  const identity = identityFromRequest(payload)
  const mode = process.env.H8A_FAKE_WORKER_MODE ?? 'complete'
  const taskDir = payload.task_dir
  await mkdir(taskDir, { recursive: true })
  await appendFile(join(dirname(taskDir), 'fake-worker-launches.log'), 'launch\n', 'utf8')
  const width = payload.width
  const height = payload.height
  const detectorPrompt = `a ${payload.authored_target}`
  if (mode === 'sleep') {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.H8A_FAKE_SLEEP_SECONDS ?? 30) * 1000),
    )
  }
  if (mode === 'stdout_flood') {
    process.stdout.write('x'.repeat(Number(process.env.H8A_FAKE_STDOUT_BYTES ?? 2_000_000)))
    return 0
  }
  if (mode === 'stderr_flood') {
    process.stderr.write('x'.repeat(Number(process.env.H8A_FAKE_STDERR_BYTES ?? 9_000_000)))
    await new Promise((resolve) => setTimeout(resolve, 500))
    process.stdout.write(
      JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'complete' }) + '\n',
    )
    return 0
  }
  if (mode === 'orphan_pipe') {
    return runOrphanPipe()
  }
  if (mode === 'stubborn_descendant') {
    spawn('bash', ['-c', 'trap "" TERM; trap "" HUP; exec tail -f /dev/null'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    process.exit(0)
  }
  if (mode === 'partial_stdout') {
    process.stdout.write('{"schema":')
    await new Promise((resolve) =>
      setTimeout(resolve, Number(process.env.H8A_FAKE_SLEEP_SECONDS ?? 30) * 1000),
    )
    return 0
  }
  if (mode === 'error') {
    const response = {
      schema: NATIVE_RESPONSE_SCHEMA,
      status: 'error',
      ...identity,
      error: 'fixture',
    }
    await writeJsonAtomic(join(taskDir, 'native-response.json'), response)
    process.stdout.write(JSON.stringify(response) + '\n')
    return 1
  }
  if (mode === 'error_bad_identity') {
    const response = {
      schema: NATIVE_RESPONSE_SCHEMA,
      status: 'error',
      request_id: randomUUID(),
      recipe_id: RECIPE_ID,
      source_sha256: payload.source_sha256,
      error: 'fixture identity error',
    }
    await writeJsonAtomic(join(taskDir, 'native-response.json'), response)
    process.stdout.write(JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'error' }) + '\n')
    return 0
  }
  if (mode === 'oversized_json') {
    const blob = 'x'.repeat(Number(process.env.H8A_FAKE_JSON_BYTES ?? 5_000_000))
    await writeFile(join(taskDir, 'native-response.json'), blob, 'utf8')
    process.stdout.write(
      JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'complete' }) + '\n',
    )
    return 0
  }
  if (
    mode === 'mask_hash_mismatch' ||
    mode === 'mask_size_mismatch' ||
    mode === 'mask_symlink' ||
    mode === 'wrong_packed_total'
  ) {
    const maskDir = join(taskDir, 'packed-masks')
    await mkdir(maskDir, { recursive: true })
    const packed = packRect(width, height, [2, 2, 4, 4])
    const realPath = join(maskDir, 'D00.real.bin')
    await writeFile(realPath, packed)
    let packedPath = join(maskDir, 'D00.bin')
    if (mode === 'mask_symlink') {
      await symlink(realPath, packedPath)
    } else if (mode === 'mask_size_mismatch') {
      await writeFile(packedPath, Buffer.concat([packed, Buffer.from([0])]))
    } else {
      await writeFile(packedPath, packed)
    }
    const declaredSha = mode === 'mask_hash_mismatch' ? '0'.repeat(64) : sha256Bytes(packed)
    const response = {
      schema: NATIVE_RESPONSE_SCHEMA,
      status: 'complete',
      ...identity,
      width,
      height,
      authored_target: payload.authored_target,
      detector_prompt: detectorPrompt,
      families: {
        D: [
          {
            id: 'D00',
            family: 'D',
            ordinal: 0,
            packed_path: packedPath,
            packed_bytes: packed.length,
            packed_sha256: declaredSha,
            empty: false,
            mask_box_xyxy: [2, 2, 6, 6],
          },
        ],
        U: [],
      },
      packed_mask_bytes_total: mode === 'wrong_packed_total' ? packed.length + 1 : packed.length,
    }
    await writeJsonAtomic(join(taskDir, 'native-response.json'), response)
    process.stdout.write(
      JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'complete' }) + '\n',
    )
    return 0
  }
  if (mode === 'bad_identity') {
    const maskDir = join(taskDir, 'packed-masks')
    await mkdir(maskDir, { recursive: true })
    const packed = packRect(width, height, [2, 2, 4, 4])
    const path = join(maskDir, 'D00.bin')
    await writeFile(path, packed)
    const response = {
      schema: NATIVE_RESPONSE_SCHEMA,
      status: 'complete',
      request_id: randomUUID(),
      recipe_id: RECIPE_ID,
      source_sha256: payload.source_sha256,
      width,
      height,
      authored_target: payload.authored_target,
      detector_prompt: detectorPrompt,
      families: {
        D: [
          {
            id: 'D00',
            family: 'D',
            ordinal: 0,
            packed_path: path,
            packed_bytes: packed.length,
            packed_sha256: sha256Bytes(packed),
            empty: false,
            mask_box_xyxy: [2, 2, 6, 6],
          },
        ],
        U: [],
      },
      packed_mask_bytes_total: packed.length,
    }
    await writeJsonAtomic(join(taskDir, 'native-response.json'), response)
    process.stdout.write(
      JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'complete' }) + '\n',
    )
    return 0
  }
  const maskDir = join(taskDir, 'packed-masks')
  await mkdir(maskDir, { recursive: true })
  const specs = [
    ['D', 'D00', 0, [2, 2, 6, 6]],
    ['D', 'D01', 1, [20, 10, 8, 5]],
    ['D', 'D02', 2, [0, 0, 0, 0]],
    ['U', 'U00', 0, [12, 12, 10, 8]],
  ]
  const families = { D: [], U: [] }
  let total = 0
  for (const [family, id, ordinal, rect] of specs) {
    const [left, top, rw, rh] = rect
    const packed = packRect(width, height, rect)
    const empty = rw === 0 || rh === 0
    total += packed.length
    const path = join(maskDir, `${id}.bin`)
    await writeFile(path, packed)
    const maskBox = empty ? null : [left, top, left + rw, top + rh]
    families[family].push({
      id,
      family,
      ordinal,
      packed_path: path,
      packed_bytes: packed.length,
      packed_sha256: sha256Bytes(packed),
      empty,
      mask_box_xyxy: maskBox,
    })
  }
  const response = {
    schema: NATIVE_RESPONSE_SCHEMA,
    status: 'complete',
    ...identity,
    width,
    height,
    authored_target: payload.authored_target,
    detector_prompt: detectorPrompt,
    families,
    packed_mask_bytes_total: total,
  }
  await writeJsonAtomic(join(taskDir, 'native-response.json'), response)
  process.stdout.write(
    JSON.stringify({ schema: NATIVE_RESPONSE_SCHEMA, status: 'complete' }) + '\n',
  )
  return 0
}

process.exitCode = await main().catch(async (error) => {
  process.stderr.write(String(error?.stack ?? error) + '\n')
  return 1
})
