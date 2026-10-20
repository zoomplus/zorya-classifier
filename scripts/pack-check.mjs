import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { scanSecretText, secretPathRules } from './secrets.mjs'

function existingNpmCli(candidate) {
  try {
    const path = realpathSync.native(candidate)
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
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createClassifier, type DecisionPort, type DecisionResult } from 'zorya-classifier'
import { createOpenRouterDecisions, type OpenRouterDecisionsOptions, createOpenRouterVision, type OpenRouterVisionOptions } from 'zorya-classifier/openrouter'
import { createOpenAICompatibleVision, type OpenAICompatibleVisionOptions } from 'zorya-classifier/openai-compatible'
import { createMobileSamSegmenter, createMobileSamObjectProposals, createGrabCutSegmenter, packBinaryMask, unpackBinaryMask } from 'zorya-classifier/segmentation'
const native: (options: OpenRouterDecisionsOptions) => DecisionPort = createOpenRouterDecisions
assert.equal(typeof native, 'function')
const transport: (options: OpenRouterVisionOptions) => DecisionPort = createOpenRouterVision
const direct: (options: OpenAICompatibleVisionOptions) => DecisionPort = createOpenAICompatibleVision
assert.equal(typeof direct, 'function')
assert.equal(typeof transport, 'function')
const packageRoot = realpathSync.native(join(process.cwd(), 'node_modules', 'zorya-classifier'))
for (const name of ['zorya-classifier', 'zorya-classifier/openrouter', 'zorya-classifier/openai-compatible', 'zorya-classifier/segmentation']) {
  const suffix = relative(packageRoot, realpathSync.native(fileURLToPath(import.meta.resolve(name))))
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
let fixtureTransportCalls = 0
const ordinary = createClassifier({decision: direct({endpoint:'http://localhost:9/v1/chat/completions', model:'fixture/ordinary-vision',fetch:async (_url,init)=>{
  fixtureTransportCalls++
  const body = String(init?.body)
  assert.ok(body.includes('image_url'))
  return new Response(JSON.stringify({model:'fixture/ordinary-vision', choices:[{index:0,finish_reason:'stop',message:{content:JSON.stringify({answers:{selection:{ranking:['yes']}}})}}]}))
}})})
try {
  const answer = await ordinary.classify({input:{image},classes:[{id:'yes',description:'Rectangle'},{id:'no',description:'No rectangle'}]})
  assert.equal(answer.choice,'yes')
  assert.equal(answer.probabilities,null)
  assert.equal(answer.nativeChoice,null)
  assert.equal(fixtureTransportCalls,1)
  console.log(JSON.stringify({ordinaryVisionAdapter:'passed',fixtureTransportCalls,providerHttpCalls:0}))
} finally { await ordinary.dispose() }
let nativeTransportCalls=0
const typed=createClassifier({decision:native({apiKey:'fixture',model:'fixture/decisions',provider:'fixture',fetch:async(url,init)=>{
 nativeTransportCalls++;assert.equal(url,'https://openrouter.ai/api/alpha/decisions');assert.ok(String(init?.body).includes('image_url'));assert.ok(!String(init?.body).includes('rankingSize'))
 return new Response(JSON.stringify({model:'fixture/decisions',provider:'fixture',answers:{selection:{type:'choice',choice:'yes',probabilities:{yes:0.7,no:0.3}}}}))
}})})
try {const answer=await typed.classify({input:{image},classes:[{id:'yes',description:'Rectangle'},{id:'no',description:'No rectangle'}]});assert.equal(answer.choice,'yes');assert.deepEqual(answer.probabilities,{yes:0.7,no:0.3});assert.equal(nativeTransportCalls,1);console.log(JSON.stringify({nativeDecisionsAdapter:'passed',nativeTransportCalls,providerHttpCalls:0}))}finally{await typed.dispose()}
const require = createRequire(import.meta.url)
assert.throws(() => require.resolve('onnxruntime-node'), {code:'MODULE_NOT_FOUND'})
assert.equal(typeof createGrabCutSegmenter,'function')
await assert.rejects(createMobileSamSegmenter({encoderPath:'not-downloaded.onnx',decoderPath:'not-downloaded.onnx'}),{code:'UNSUPPORTED'})
assert.equal(typeof createMobileSamObjectProposals,'function')
assert.deepEqual(unpackBinaryMask(packBinaryMask(new Uint8Array([1,0,1,0]),2,2)),new Uint8Array([1,0,1,0]))
await assert.rejects(createMobileSamObjectProposals({encoderPath:'not-downloaded.onnx',decoderPath:'not-downloaded.onnx'}),{code:'UNSUPPORTED'})
let segmenterDisposals=0
const whole=createClassifier({decision:{async decide(request){
 const answers:DecisionResult['answers']={}
 for(const [id,q] of Object.entries(request.questions)){
  if(q.type==='noul'){answers[id]={type:'presence',presence:'present'};continue}
  if(id==='instance'){answers[id]={type:'ranked-choice',ranking:['same']};continue}
  const coordinate=id==='right'?99:id==='bottom'?79:0
  const boundary=Object.entries(q.criteria).find(([,text])=>{
   const parts=/^Integer boundary coordinates in \\[(\\d+), (\\d+)\\)\\.$/.exec(text)
   return parts!==null && coordinate>=Number(parts[1]) && coordinate<Number(parts[2])
  })?.[0]
  answers[id]={type:'ranked-choice',ranking:boundary?[boundary]:Object.keys(q.criteria).slice(0,q.rankingSize??4)}
 }
 return {answers,metadata:{model:'fixture',provider:'fixture',requestId:null,durationMs:0,costUsd:0,attempts:1}}
}},segmentation:{async segment(input){
 const mask=new Uint8Array(input.image.width*input.image.height)
 for(let y=0;y<10;y++)for(let x=0;x<10;x++)mask[y*input.image.width+x]=1
 return {status:'segmented',mask:{data:mask,width:input.image.width,height:input.image.height,format:'binary-u8'},metadata:{method:'fixture',backend:'fixture',durationMs:0,input:{width:input.image.width,height:input.image.height}}}
},settle:async()=>{},dispose:async()=>{segmenterDisposals++}}})
try{
 const location=await whole.locate({image,target:'Synthetic rectangle',mode:'whole-object'})
 assert.equal(location.status,'located')
 if(location.status==='located'){assert.equal(location.kind,'whole-object');assert.ok(location.region.width>=100);assert.ok(location.region.height>=80)}
 const extracted=await whole.extract({image,target:'Synthetic rectangle'})
 assert.equal(extracted.status,'extracted')
 if(extracted.status==='extracted'){
  assert.equal(extracted.png[0],137);assert.equal(extracted.mask.data.length,100)
  assert.deepEqual(extracted.region,{left:0,top:0,width:10,height:10})
 }
 console.log(JSON.stringify({wholeObject:'passed',extract:'passed',optionalOnnxAbsent:true,providerHttpCalls:0}))
}finally{await whole.dispose()}
assert.equal(segmenterDisposals,0)
let proposalDisposals=0
const proposals=createClassifier({decision,objectProposals:{async propose(input){
 const pixels=input.image.width*input.image.height
 const data=new Uint8Array(pixels);data.fill(1)
 return {proposals:[{id:'C00',mask:packBinaryMask(data,input.image.width,input.image.height),qualityScore:-2}],metadata:{method:'fixture-proposals',backend:'fixture',durationMs:0,input:{width:input.image.width,height:input.image.height},qualityScore:-2}}
},settle:async()=>{throw new Error('SDK must not globally settle a shared port')},dispose:async()=>{proposalDisposals++}}})
try{
 const location=await proposals.locate({image,target:'Synthetic rectangle',mode:'whole-object'})
 assert.equal(location.status,'located')
 if(location.status==='located')assert.equal(location.method,'pixel-mask-proposals-v1')
 const cutout=await proposals.extract({image,target:'Synthetic rectangle'})
 assert.equal(cutout.status,'extracted')
 if(cutout.status==='extracted'){assert.equal(cutout.segmentation.qualityScore,-2);assert.deepEqual(cutout.region,{left:0,top:0,width:512,height:384})}
 console.log(JSON.stringify({pixelMaskProposals:'passed',proposalExtract:'passed',optionalOnnxAbsent:true,providerHttpCalls:0}))
}finally{await proposals.dispose()}
assert.equal(proposalDisposals,0)
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
  const compiler = realpathSync.native(resolve('node_modules/typescript/bin/tsc'))
  const compilerLib = realpathSync.native(join(dirname(compiler), '..', 'lib'))
  const listed = execute(
    process.execPath,
    [compiler, '--project', 'tsconfig.json', '--listFiles'],
    dir,
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  const consumerRoot = realpathSync.native(dir)
  for (const file of listed) {
    const actual = realpathSync.native(file)
    if (
      !within(consumerRoot, actual) &&
      !(within(compilerLib, actual) && /^lib\..*\.d\.ts$/.test(basename(actual)))
    )
      throw new Error(
        'Consumer declaration resolution escaped its install and compiler standard libraries',
      )
  }
  for (const name of [
    'index.d.ts',
    'openrouter.d.ts',
    'openai-compatible.d.ts',
    'segmentation.d.ts',
  ]) {
    const expected = realpathSync.native(
      join(dir, 'node_modules', 'zorya-classifier', 'dist', name),
    )
    if (!listed.some((file) => realpathSync.native(file) === expected))
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
