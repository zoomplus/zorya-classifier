import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const script = fileURLToPath(new URL('../scripts/secrets.mjs', import.meta.url))
const finding = z.object({ path: z.string(), rule: z.string(), line: z.number().int() }).strict()
const findings = z.array(finding)
const token = () => ['sk', 'or', 'v1', 'Ab9_'.repeat(8)].join('-')
const password = () => ['aZ9!', 'B7q_', 'v2X-', 'R8m+', 'p4T=', 'd6K/'].join('')
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    env: isolatedEnv(),
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
async function repository(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'zorya-secrets-'))
  try {
    git(root, 'init', '--quiet')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
async function file(root: string, path: string, text: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}
let repositoryLocalGitEnvVarNamesCache: string[] | undefined
function envWithoutRepositoryGitVariables() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}
function repositoryLocalGitEnvVarNames() {
  if (repositoryLocalGitEnvVarNamesCache) return repositoryLocalGitEnvVarNamesCache
  const output = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    env: envWithoutRepositoryGitVariables(),
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  repositoryLocalGitEnvVarNamesCache = output.trim().split(/\r?\n/u).filter(Boolean)
  return repositoryLocalGitEnvVarNamesCache
}
function isolatedEnv() {
  const env = { ...process.env }
  for (const name of repositoryLocalGitEnvVarNames()) delete env[name]
  return env
}
function cli(root: string, mode: '--staged' | '--worktree' = '--staged') {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [script, mode], {
        cwd: root,
        env: isolatedEnv(),
        shell: false,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    }
  } catch (error) {
    assert.ok(error instanceof Error && 'status' in error && 'stderr' in error && 'stdout' in error)
    assert.equal(typeof error.status, 'number')
    assert.equal(typeof error.stderr, 'string')
    assert.equal(typeof error.stdout, 'string')
    return {
      code: Number(error.status),
      stdout: String(error.stdout),
      stderr: String(error.stderr),
    }
  }
}
function violations(stderr: string) {
  return findings.parse(
    stderr
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  )
}
function pure(path: string, text: string) {
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const mod=await import(process.argv[1]); const input=JSON.parse(process.argv[2]); console.log(JSON.stringify({paths:mod.secretPathRules(input.path),findings:mod.scanSecretText(input.path,input.text)}))',
      pathToFileURL(script).href,
      JSON.stringify({ path, text }),
    ],
    { shell: false, encoding: 'utf8' },
  )
  return z.object({ paths: z.array(z.string()), findings }).parse(JSON.parse(result))
}

await test('secret filename checks reject private inputs and keep exact example templates', () => {
  for (const path of [
    '.env',
    'sub/.env.local',
    '.npmrc',
    'sub/.npmrc.backup',
    'user.pem',
    'key.p12',
    'identity.pfx',
    'id_ed25519',
    'id_ed25519_sk',
    '.ssh/config',
    'secrets/value.txt',
    'private/config.json',
    '.run/replay.json',
  ]) {
    assert.ok(pure(path, '').paths.length > 0, path)
  }
  for (const path of ['.env.example', 'sub/.npmrc.example', 'docs/api.md', 'test/fixture.ts']) {
    assert.deepEqual(pure(path, '').paths, [])
  }
})
await test('known provider prefixes, private keys, database credentials and entropy are detected without excerpts', () => {
  const cases: [string, string][] = [
    ['openrouter-key', token()],
    ['openai-key', ['sk', 'proj', 'B9x_'.repeat(8)].join('-')],
    ['anthropic-key', ['sk', 'ant', 'api03', 'B9x_'.repeat(8)].join('-')],
    ['github-token', ['ghp', 'X'.repeat(24)].join('_')],
    ['aws-access-key', ['AK', 'IA', 'Q'.repeat(16)].join('')],
    ['brave-key', ['BS', 'A', 'Z9q'.repeat(9)].join('')],
    ['pem-private-key', ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')],
    [
      'database-credentials',
      ['postgresql://player:', encodeURIComponent(password()), '@localhost/db'].join(''),
    ],
    ['high-entropy-credential', `API_KEY="${password()}"`],
  ]
  for (const [rule, content] of cases) {
    const result = pure('docs/example.txt', `ordinary line\n${content}\n`)
    assert.ok(
      result.findings.some((item) => item.rule === rule && item.line === 2),
      rule,
    )
    assert.ok(result.findings.every((item) => item.path === 'docs/example.txt'))
    assert.equal(JSON.stringify(result).includes(content), false)
  }
})
await test('empty templates and obvious low-entropy samples do not trigger credential heuristics', () => {
  assert.deepEqual(pure('.env.example', 'OPENROUTER_API_KEY=\nPASSWORD=\n').findings, [])
  assert.deepEqual(
    pure(
      'test/sample.ts',
      "const secret='secret-token-do-not-return'\nconst token='aaaaaaaaaaaaaaaaaaaaaaaa'\n",
    ).findings,
    [],
  )
})
await test('staged secret remains rejected when the working file has already been cleaned', async () => {
  await repository(async (root) => {
    const path =
      process.platform === 'win32' ? 'notes with spaces.ts' : 'notes with spaces\nquoted".ts'
    await file(root, path, `export const value = '${token()}'\n`)
    git(root, 'add', '--', path)
    await file(root, path, 'export const value = undefined\n')
    const result = cli(root)
    assert.equal(result.code, 1)
    assert.ok(
      violations(result.stderr).some(
        (item) => item.path === path && item.rule === 'openrouter-key',
      ),
    )
    assert.equal(result.stdout.includes(token()) || result.stderr.includes(token()), false)
    assert.equal(cli(root, '--worktree').code, 0)
  })
})
await test('clean staged content is independent of a later working-tree secret', async () => {
  await repository(async (root) => {
    await file(root, 'app.ts', 'export const value = undefined\n')
    git(root, 'add', '--', 'app.ts')
    await file(root, 'app.ts', token())
    assert.equal(cli(root).code, 0)
    assert.equal(cli(root, '--worktree').code, 1)
  })
})
await test('staged scan uses the child cwd repository when hook GIT_* variables point elsewhere', async () => {
  const savedGitDir = process.env.GIT_DIR
  const savedGitWorkTree = process.env.GIT_WORK_TREE
  const savedGitIndexFile = process.env.GIT_INDEX_FILE
  const savedGitCommonDir = process.env.GIT_COMMON_DIR
  const sentinelRoot = await mkdtemp(join(tmpdir(), 'zorya-secrets-sentinel-'))
  const subjectRoot = await mkdtemp(join(tmpdir(), 'zorya-secrets-subject-'))
  const sentinelGitDir = join(sentinelRoot, '.git')
  const sentinelIndexPath = join(sentinelGitDir, 'index')
  try {
    git(sentinelRoot, 'init', '--quiet')
    await file(sentinelRoot, 'sentinel.txt', 'sentinel marker\n')
    git(sentinelRoot, 'add', '--', 'sentinel.txt')
    const sentinelIndexBytesBefore = await readFile(sentinelIndexPath)

    process.env.GIT_DIR = sentinelGitDir
    process.env.GIT_WORK_TREE = sentinelRoot
    process.env.GIT_INDEX_FILE = sentinelIndexPath
    process.env.GIT_COMMON_DIR = sentinelGitDir

    git(subjectRoot, 'init', '--quiet')
    const subjectPath = 'subject.ts'
    await file(subjectRoot, subjectPath, `export const value = '${token()}'\n`)
    git(subjectRoot, 'add', '--', subjectPath)

    const result = cli(subjectRoot)
    assert.equal(result.code, 1)
    assert.ok(
      violations(result.stderr).some(
        (item) => item.path === subjectPath && item.rule === 'openrouter-key',
      ),
    )
    assert.equal(result.stdout.includes(token()) || result.stderr.includes(token()), false)

    const sentinelIndexBytesAfter = await readFile(sentinelIndexPath)
    assert.deepEqual(sentinelIndexBytesAfter, sentinelIndexBytesBefore)
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = savedGitDir
    if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = savedGitWorkTree
    if (savedGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = savedGitIndexFile
    if (savedGitCommonDir === undefined) delete process.env.GIT_COMMON_DIR
    else process.env.GIT_COMMON_DIR = savedGitCommonDir
    await rm(sentinelRoot, { recursive: true, force: true })
    await rm(subjectRoot, { recursive: true, force: true })
  }
})
await test('worktree scan includes untracked files and skips ignored env without opening it', async () => {
  await repository(async (root) => {
    await file(root, '.gitignore', '.env\n.run/\n')
    await file(root, '.env', token())
    await file(root, '.run/private.json', token())
    assert.equal(cli(root, '--worktree').code, 0)
    await file(root, 'new.ts', token())
    assert.equal(cli(root, '--worktree').code, 1)
  })
})
await test('forced-staged ignored env is rejected by filename, without content findings', async () => {
  await repository(async (root) => {
    await file(root, '.gitignore', '.env\n')
    await file(root, '.env', token())
    git(root, 'add', '--force', '--', '.env')
    const result = cli(root)
    assert.equal(result.code, 1)
    const rows = violations(result.stderr)
    assert.ok(rows.some((item) => item.rule === 'environment-file'))
    assert.ok(rows.some((item) => item.rule === 'ignored-tracked-path'))
    assert.equal(
      rows.some((item) => item.rule === 'openrouter-key'),
      false,
    )
  })
})
await test('example templates are not a content allowlist', async () => {
  await repository(async (root) => {
    await file(root, '.env.example', `OPENROUTER_API_KEY=${token()}`)
    git(root, 'add', '--', '.env.example')
    const result = cli(root)
    assert.equal(result.code, 1)
    assert.ok(violations(result.stderr).some((item) => item.rule === 'openrouter-key'))
  })
})
await test('binary content is explicitly counted, while private binary filenames are rejected', async () => {
  await repository(async (root) => {
    await file(root, 'diagram.png', Buffer.from([137, 80, 78, 71, 0, 255]))
    git(root, 'add', '--', 'diagram.png')
    const result = cli(root)
    assert.equal(result.code, 0)
    assert.equal(
      z.object({ skippedBinary: z.number() }).parse(JSON.parse(result.stdout)).skippedBinary,
      1,
    )
    await file(root, 'identity.pfx', Buffer.from([0, 255]))
    git(root, 'add', '--', 'identity.pfx')
    assert.equal(cli(root).code, 1)
  })
})
await test('oversized text fails closed instead of silently omitting the file', async () => {
  await repository(async (root) => {
    await file(root, 'large.txt', 'x'.repeat(2 * 1024 * 1024 + 1))
    const result = cli(root, '--worktree')
    assert.equal(result.code, 1)
    assert.ok(violations(result.stderr).some((item) => item.rule === 'file-size-limit'))
  })
})
await test('staged symlink blobs are rejected without following a filesystem target', async () => {
  await repository(async (root) => {
    await file(root, 'target.txt', 'outside-target')
    const oid = git(root, 'hash-object', '-w', '--', 'target.txt').trim()
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${oid},link.txt`)
    const result = cli(root)
    assert.equal(result.code, 1)
    assert.ok(violations(result.stderr).some((item) => item.rule === 'non-file-index-entry'))
  })
})
await test('repository gitignore protects local credentials, caches and releases but not examples or source', async () => {
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8')
  await repository(async (root) => {
    await file(root, '.gitignore', ignore)
    const ignored = [
      '.env',
      'sub/.env.local',
      '.npmrc',
      'sub/.npmrc.backup',
      'key.pem',
      'identity.pfx',
      'id_rsa',
      'secrets/value.txt',
      'private/value.txt',
      '.run/result.json',
      '.cache/cache.json',
      'node_modules/pkg/a.js',
      'release/app.exe',
      'debug.log',
    ]
    for (const path of ignored) {
      assert.equal(git(root, 'check-ignore', '--no-index', '--', path).trim(), path)
    }
    for (const path of [
      '.env.example',
      'sub/.env.example',
      '.npmrc.example',
      'sub/.npmrc.example',
      'src/index.ts',
      'test/secrets.test.ts',
      'docs/api.md',
    ]) {
      try {
        git(root, 'check-ignore', '--no-index', '--', path)
        assert.fail(`Unexpected ignored path ${path}`)
      } catch (error) {
        assert.ok(error instanceof Error && 'status' in error && error.status === 1)
      }
    }
  })
})

await test('git failures expose only a sanitized rule and no Git diagnostic text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-not-repository-'))
  try {
    const result = cli(root)
    assert.equal(result.code, 1)
    assert.deepEqual(violations(result.stderr), [{ path: '.', rule: 'git-read-failed', line: 0 }])
    assert.equal(result.stderr.includes('fatal:'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('unquoted environment references are code, while literal quoted credentials remain scanned', () => {
  assert.deepEqual(pure('example.ts', 'apiKey: process.env.OPENROUTER_API_KEY!\n').findings, [])
  assert.deepEqual(pure('example.ts', 'apiKey: import.meta.env.OPENROUTER_API_KEY\n').findings, [])
  assert.ok(
    pure('example.ts', `apiKey: "${password()}"`).findings.some(
      (item) => item.rule === 'high-entropy-credential',
    ),
  )
})
await test(
  'POSIX tracked FIFO replacement cannot block the scanner',
  { skip: process.platform === 'win32' },
  async () => {
    await repository(async (root) => {
      await file(root, 'pipe.txt', 'previously regular file')
      git(root, 'add', '--', 'pipe.txt')
      await rm(join(root, 'pipe.txt'))
      execFileSync('mkfifo', [join(root, 'pipe.txt')], { shell: false, timeout: 5000 })
      const result = cli(root, '--worktree')
      assert.equal(result.code, 1)
      assert.ok(violations(result.stderr).some((item) => item.rule === 'non-file-path'))
    })
  },
)

await test('leading BOM in an untracked Git filename cannot alias a clean tracked file', async () => {
  await repository(async (root) => {
    await file(root, 'app.txt', 'safe')
    git(root, 'add', '--', 'app.txt')
    const path = '\uFEFFapp.txt'
    await file(root, path, token())
    const result = cli(root, '--worktree')
    assert.equal(result.code, 1)
    assert.ok(
      violations(result.stderr).some(
        (item) => item.path === path && item.rule === 'openrouter-key',
      ),
    )
    assert.equal(result.stderr.includes(token()), false)
  })
})
