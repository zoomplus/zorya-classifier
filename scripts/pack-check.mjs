import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { scanSecretText, secretPathRules } from './secrets.mjs'

function existingNpmCli(candidate) {
  try {
    const path = realpathSync(candidate)
    return basename(path) === 'npm-cli.js' && statSync(path).isFile() ? path : null
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}
function resolveNpmCli() {
  const declared = process.env.npm_execpath
  if (declared) {
    const path = isAbsolute(declared) ? existingNpmCli(declared) : null
    if (!path) throw new Error('npm_execpath must identify an existing absolute npm-cli.js')
    return path
  }
  // Direct node invocation: inspect PATH candidates; never execute a cmd/sh wrapper.
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!isAbsolute(directory)) continue
    for (const candidate of [
      join(directory, 'npm'),
      join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]) {
      const path = existingNpmCli(candidate)
      if (path) return path
    }
  }
  throw new Error('Cannot find npm-cli.js; run through npm or provide a Node/npm directory in PATH')
}
const npm = resolveNpmCli()
function execute(executable, args, cwd = process.cwd()) {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function run(args, cwd = process.cwd()) {
  return execute(process.execPath, [npm, ...args], cwd)
}
function within(root, path) {
  const suffix = relative(root, path)
  return (
    suffix === '' ||
    (suffix !== '..' &&
      !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(suffix))
  )
}
const consumerProbe = `import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createClassifier, type DecisionPort, type DecisionResult } from 'zorya-classifier'
import { createOpenRouterJev, type OpenRouterJevOptions } from 'zorya-classifier/openrouter'
const transport: (options: OpenRouterJevOptions) => DecisionPort = createOpenRouterJev
assert.equal(typeof transport, 'function')
const packageRoot = realpathSync(join(process.cwd(), 'node_modules', 'zorya-classifier'))
for (const name of ['zorya-classifier', 'zorya-classifier/openrouter']) {
  const suffix = relative(packageRoot, realpathSync(fileURLToPath(import.meta.resolve(name))))
  assert.ok(suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix))
}
const image = await sharp({create:{width:512,height:384,channels:3,background:'#336699'}}).png().toBuffer()
let calls = 0
const decision: DecisionPort = { async decide(request, signal) {
  assert.equal(signal.aborted, false)
  const pictures = request.state.filter(part => typeof part !== 'string')
  assert.ok(pictures.length > 0)
  for (const part of pictures) {
    const encoded = part.image_url.url.slice(part.image_url.url.indexOf(',') + 1)
    const metadata = await sharp(Buffer.from(encoded, 'base64')).metadata()
    assert.ok(metadata.width >= 280 && metadata.width <= 1568 && metadata.height >= 280 && metadata.height <= 1568)
  }
  const answers: DecisionResult['answers'] = {}
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria), first = options[0]
      assert.ok(first)
      answers[key] = {type:'choice',choice:first,probabilities:Object.fromEntries(options.map((id,index)=>[id,index===0?1:0]))}
    } else answers[key] = {type:'noul',noul:key==='presence'?1:0}
  }
  calls++
  return {answers,metadata:{model:null,provider:null,requestId:null,durationMs:0,costUsd:null,attempts:1}}
}}
const classifier = createClassifier({decision})
try {
  const classified = await classifier.classify({input:{text:'Synthetic rectangle',image},classes:[{id:'yes',description:'Rectangle'},{id:'no',description:'No rectangle'}]})
  assert.equal(classified.choice, 'yes')
  const located = await classifier.locate({image,target:'Synthetic rectangle'})
  assert.ok(located.status === 'located')
  assert.ok(located.region.width > 0 && located.region.height > 0)
  console.log(JSON.stringify({independentConsumer:'passed',declarations:'compiled',sharp:sharp.versions.sharp,vips:sharp.versions.vips,classification:classified.choice,localization:located.status,controlledDecisionCalls:calls,providerHttpCalls:0}))
} finally { await classifier.dispose() }
`

run(['run', 'build'])
const dir = await mkdtemp(join(tmpdir(), 'zorya-consumer-'))
try {
  const packed = JSON.parse(
    run(['pack', '--ignore-scripts', '--json', '--pack-destination', dir]),
  )[0]
  if (!packed?.filename || !Array.isArray(packed.files)) throw new Error('Invalid npm pack result')
  const distPins = []
  const packagePins = new Map()
  for (const f of packed.files) {
    if (
      !/^(dist\/|docs\/|README\.md$|LICENSE$|NOTICE\.md$|package\.json$)/.test(f.path) ||
      /(\.env|node_modules|\.map$|session\.log|\.run)/.test(f.path)
    )
      throw new Error(`Unwanted package file: ${f.path}`)
    const bytes = await readFile(resolve(f.path)),
      data = bytes.toString('utf8')
    if (
      /(?:sk-or-v1-|sk-proj-)[A-Za-z0-9_-]{20,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|\/root\/work\/|workspace:\*/.test(
        data,
      )
    )
      throw new Error(`Potential private data: ${f.path}`)
    const secretFindings = [...secretPathRules(f.path), ...scanSecretText(f.path, data)]
    if (secretFindings.length) throw new Error(`Potential credential in package file: ${f.path}`)
    packagePins.set(f.path, createHash('sha256').update(bytes).digest('hex'))
    if (f.path.startsWith('dist/'))
      distPins.push({
        path: f.path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
  }
  const archive = join(dir, packed.filename)
  const dev = JSON.parse(await readFile(resolve('package.json'), 'utf8')).devDependencies
  const nodeTypes = dev['@types/node']
  if (typeof nodeTypes !== 'string' || !/^\d+\.\d+\.\d+$/.test(nodeTypes))
    throw new Error('Consumer requires a pinned @types/node version')
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'zorya-independent-consumer', private: true, type: 'module' }),
  )
  run(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, `@types/node@${nodeTypes}`],
    dir,
  )
  // Inspect the actual installed archive, not only source files listed by npm pack.
  for (const [path, sha256] of packagePins) {
    const bytes = await readFile(join(dir, 'node_modules', 'zorya-classifier', path))
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error(`Archive differs from scanned source: ${path}`)
    if (secretPathRules(path).length || scanSecretText(path, bytes.toString('utf8')).length)
      throw new Error(`Potential credential in installed archive: ${path}`)
  }
  await writeFile(join(dir, 'probe.ts'), consumerProbe)
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        lib: ['ES2023', 'DOM'],
        types: ['node'],
        typeRoots: [join(dir, 'node_modules', '@types')],
        rootDir: '.',
        outDir: 'compiled',
        declaration: false,
        sourceMap: false,
        skipLibCheck: false,
      },
      include: ['probe.ts'],
    }),
  )
  const compiler = realpathSync(resolve('node_modules/typescript/bin/tsc'))
  const compilerLib = realpathSync(join(dirname(compiler), '..', 'lib'))
  const listed = execute(
    process.execPath,
    [compiler, '--project', 'tsconfig.json', '--listFiles'],
    dir,
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  const consumerRoot = realpathSync(dir)
  for (const file of listed) {
    const actual = realpathSync(file)
    if (
      !within(consumerRoot, actual) &&
      !(within(compilerLib, actual) && /^lib\..*\.d\.ts$/.test(basename(actual)))
    )
      throw new Error(
        'Consumer declaration resolution escaped its install and compiler standard libraries',
      )
  }
  for (const name of ['index.d.ts', 'openrouter.d.ts']) {
    const expected = realpathSync(join(dir, 'node_modules', 'zorya-classifier', 'dist', name))
    if (!listed.some((file) => realpathSync(file) === expected))
      throw new Error(`Consumer did not resolve installed ${name}`)
  }
  console.log(execute(process.execPath, [join(dir, 'compiled', 'probe.js')], dir).trim())
  distPins.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  console.log(
    JSON.stringify({
      files: packed.files.length,
      unpackedSize: packed.unpackedSize,
      sha256: createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      runtimeDistFiles: distPins.length,
      runtimeDistSha256: createHash('sha256').update(JSON.stringify(distPins)).digest('hex'),
      consumerDeclarationFiles: listed.length,
      npmTransport: 'node npm-cli.js; shell:false',
    }),
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}
