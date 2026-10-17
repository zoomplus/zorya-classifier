import { spawnSync } from 'node:child_process'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const fileLimit = 2 * 1024 * 1024
const totalLimit = 32 * 1024 * 1024
const listingLimit = 8 * 1024 * 1024
const fileCountLimit = 10_000
const findingLimit = 100
const blockedDirectories = new Set([
  '.git',
  'node_modules',
  '.run',
  'secrets',
  '.secrets',
  'private',
  '.private',
  'credentials',
  '.credentials',
  '.ssh',
  '.aws',
  '.azure',
])
const patterns = [
  ['openrouter-key', /\bsk-or-v1-[A-Za-z0-9_-]{20,}/u],
  ['openai-key', /\bsk-(?!or-v1-|ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/u],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/u],
  ['github-token', /\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]{20,}/u],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['brave-key', /\bBSA[A-Za-z0-9_-]{20,}/u],
  ['pem-private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u],
  [
    'database-credentials',
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|mssql|sqlserver|oracle):\/\/[^\s/:@]+:[^\s/@]+@/iu,
  ],
]

/** Filename checks never open the file, including ignored or forced-staged credentials. */
export function secretPathRules(path) {
  const parts = path.replaceAll('\\', '/').split('/')
  const name = parts.at(-1)?.toLowerCase() ?? ''
  const result = []
  if (parts.some((part) => blockedDirectories.has(part.toLowerCase())))
    result.push('forbidden-directory')
  if (/^\.env/u.test(name) && name !== '.env.example') result.push('environment-file')
  if (/^\.npmrc/u.test(name) && name !== '.npmrc.example') result.push('npm-credentials-file')
  if (/\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx)$/u.test(name)) result.push('private-key-file')
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/u.test(name)) result.push('identity-key-file')
  return result
}
function entropy(value) {
  const counts = new Map()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let score = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    score -= probability * Math.log2(probability)
  }
  return score
}
function credentialAssignment(line) {
  const assignments =
    /["']?([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?\s*[:=]\s*(["']?)([A-Za-z0-9_+/=!.%-]{20,512})/gu
  for (const match of line.matchAll(assignments)) {
    const key = match[1].replaceAll(/[^A-Za-z]/gu, '').toLowerCase()
    const value = match[3]
    if (!match[2] && /^(?:process\.env|import\.meta\.env)\.[A-Za-z_][A-Za-z0-9_]*!?$/u.test(value))
      continue
    if (
      !/(?:apikey|accesstoken|authtoken|refreshtoken|clientsecret|secretaccesskey|password|passwd|pwd|secret|token|authorization)$/u.test(
        key,
      )
    )
      continue
    if (/^(?:example|placeholder|dummy|redacted|changeme|your[-_]|not[-_]a[-_])/iu.test(value))
      continue
    if (entropy(value) >= 3.5) return true
  }
  return false
}
/** Bounded text heuristics; findings intentionally contain no matched values or excerpts. */
export function scanSecretText(path, text) {
  if (Buffer.byteLength(text, 'utf8') > fileLimit)
    return [{ path, rule: 'file-size-limit', line: 0 }]
  const findings = []
  let number = 0
  for (const line of text.split('\n')) {
    number++
    for (const [rule, pattern] of patterns) {
      if (pattern.test(line)) findings.push({ path, rule, line: number })
    }
    if (credentialAssignment(line))
      findings.push({ path, rule: 'high-entropy-credential', line: number })
    if (findings.length >= findingLimit) {
      findings.push({ path, rule: 'finding-limit', line: number })
      break
    }
  }
  return findings
}
class ScanFailure extends Error {
  constructor(rule, path = '.') {
    super(rule)
    this.rule = rule
    this.path = path
  }
}
function git(cwd, args, input, maxBuffer = listingLimit, allowNoMatch = false) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    shell: false,
    input,
    maxBuffer,
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.error || (result.status !== 0 && !(allowNoMatch && result.status === 1)))
    throw new ScanFailure('git-read-failed')
  return result.stdout
}
function decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ScanFailure('invalid-git-path-encoding')
  }
}
function nulPaths(bytes) {
  const text = decode(bytes)
  if (text && !text.endsWith('\0')) throw new ScanFailure('invalid-git-list')
  const paths = text ? text.slice(0, -1).split('\0') : []
  if (paths.length > fileCountLimit) throw new ScanFailure('file-count-limit')
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.split('/').includes('..'))
      throw new ScanFailure('invalid-git-path')
  }
  return paths
}
function indexEntries(root) {
  const entries = new Map()
  for (const record of nulPaths(git(root, ['ls-files', '--stage', '-z', '--']))) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/u.exec(record)
    if (!match) throw new ScanFailure('invalid-git-index')
    const [, mode, oid, stage, path] = match
    if (stage === '0') entries.set(path, { mode, oid })
  }
  return entries
}
function checkedWorktreeFile(root, path) {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
    throw new ScanFailure('outside-worktree', path)
  let current = root
  for (const part of path.split('/')) {
    current = resolve(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new ScanFailure('symlink-path', path)
    if (current === target && !stat.isFile()) throw new ScanFailure('non-file-path', path)
  }
  const fd = openSync(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new ScanFailure('non-file-path', path)
    if (stat.size > fileLimit) throw new ScanFailure('file-size-limit', path)
    const bytes = Buffer.allocUnsafe(fileLimit + 1)
    let size = 0
    while (size < bytes.length) {
      const amount = readSync(fd, bytes, size, bytes.length - size, null)
      if (amount === 0) break
      size += amount
    }
    if (size > fileLimit) throw new ScanFailure('file-size-limit', path)
    return bytes.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}
function indexedFile(root, path, entries) {
  const entry = entries.get(path)
  if (!entry) throw new ScanFailure('unmerged-or-missing-index', path)
  if (!['100644', '100755'].includes(entry.mode))
    throw new ScanFailure('non-file-index-entry', path)
  const size = Number(decode(git(root, ['cat-file', '-s', entry.oid], undefined, 128)).trim())
  if (!Number.isSafeInteger(size) || size < 0 || size > fileLimit)
    throw new ScanFailure('file-size-limit', path)
  return git(root, ['cat-file', 'blob', entry.oid], undefined, fileLimit + 1)
}
function run(mode) {
  const top = decode(git(process.cwd(), ['rev-parse', '--show-toplevel']))
  if (!top.endsWith('\n')) throw new ScanFailure('invalid-git-root')
  const root = realpathSync(top.slice(0, -1).replace(/\r$/u, ''))
  const paths = [
    ...new Set(
      nulPaths(
        git(
          root,
          mode === '--staged'
            ? ['diff', '--cached', '--name-only', '--diff-filter=ACMRU', '-z', '--']
            : ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'],
        ),
      ),
    ),
  ]
  const ignored = paths.length
    ? new Set(
        nulPaths(
          git(
            root,
            ['check-ignore', '--no-index', '-z', '--stdin'],
            Buffer.from(paths.join('\0') + '\0'),
            listingLimit,
            true,
          ),
        ),
      )
    : new Set()
  const entries = mode === '--staged' ? indexEntries(root) : undefined
  let totalBytes = 0,
    scanned = 0,
    skippedBinary = 0
  const findings = []
  for (const path of paths) {
    if (findings.length >= 1000) {
      findings.push({ path, rule: 'total-finding-limit', line: 0 })
      break
    }
    const rules = secretPathRules(path)
    if (ignored.has(path)) rules.push('ignored-tracked-path')
    if (rules.length) {
      findings.push(...rules.map((rule) => ({ path, rule, line: 0 })))
      continue
    }
    let bytes
    try {
      bytes =
        mode === '--staged' ? indexedFile(root, path, entries) : checkedWorktreeFile(root, path)
    } catch (error) {
      findings.push({
        path,
        rule: error instanceof ScanFailure ? error.rule : 'file-read-failed',
        line: 0,
      })
      continue
    }
    totalBytes += bytes.length
    if (totalBytes > totalLimit) {
      findings.push({ path, rule: 'total-size-limit', line: 0 })
      break
    }
    if (bytes.includes(0)) {
      skippedBinary++
      continue
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      skippedBinary++
      continue
    }
    scanned++
    findings.push(...scanSecretText(path, text))
  }
  for (const finding of findings) console.error(JSON.stringify(finding))
  if (findings.length) process.exitCode = 1
  else console.log(JSON.stringify({ status: 'PASS', mode, scanned, skippedBinary, totalBytes }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args[0] && !['--staged', '--worktree'].includes(args[0])))
      throw new ScanFailure('cli-usage')
    run(args[0] ?? '--staged')
  } catch (error) {
    console.error(
      JSON.stringify({
        path: error instanceof ScanFailure ? error.path : '.',
        rule: error instanceof ScanFailure ? error.rule : 'scan-failed',
        line: 0,
      }),
    )
    process.exitCode = 1
  }
}
