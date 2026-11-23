/**
 * Offline harness for the Host half: drives `apply()` with a stub ctx and a
 * stub `res`, so request handling, error codes and the model-call wiring are
 * exercised without a running DSH.
 */
import { apply } from '../index.js'

const results = []
function check(name, passed, detail) {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : '  <- ' + detail}`)
}

/** Fake IncomingMessage carrying one JSON body. */
function makeRequest(method, url, body, options = {}) {
  const chunks = []
  if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body), 'utf8'))
  let sent = false
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (sent) return
      sent = true
      for (const chunk of chunks) yield chunk
    },
    on() {},
    off() {},
    ...options,
  }
}

/** Fake ServerResponse that records the answer. */
function makeResponse() {
  const record = { status: 0, headers: undefined, body: '', ended: false, writableEnded: false, destroyed: false }
  return {
    record,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(body) {
      record.body = body
      record.ended = true
      this.writableEnded = true
    },
    on() {},
    off() {},
  }
}

/** Stub ctx: one effect runner, one route slot, one model. */
function makeContext({ streamText = 'OPTIMIZED', streamError = null, chunks = null } = {}) {
  const state = { route: undefined, modelInfoCalls: 0, streamCalls: 0 }
  const llm = {
    async resolveModelInfo() {
      state.modelInfoCalls += 1
      return { reasoning: { efforts: [{ id: 'minimal' }, { id: 'off' }] } }
    },
    async *stream(request) {
      state.streamCalls += 1
      state.lastRequest = request
      if (streamError) throw streamError
      const parts = chunks ?? [
        { type: 'text', text: streamText.slice(0, 4) },
        { type: 'text', text: streamText.slice(4) },
      ]
      for (const part of parts) yield part
    },
  }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    webServer: {
      register(config) {
        state.route = config
        return () => {
          state.route = undefined
        }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    llm,
    get(name) {
      return name === 'llm' ? llm : undefined
    },
    state,
  }
  return ctx
}

apply(makeContext(), {})
const route = makeContext()
const ctx = route
apply(ctx, {})
const registered = ctx.state.route
check('apply() registers one prefix route', Boolean(registered) && registered.kind === 'prefix', JSON.stringify(registered))

async function call(method, url, body, response = makeResponse(), options) {
  const req = makeRequest(method, url, body, options)
  await registered.handler(req, response)
  let payload
  try {
    payload = JSON.parse(response.record.body)
  } catch {
    payload = response.record.body
  }
  return { status: response.record.status, payload, headers: response.record.headers }
}

// 1. health
const health = await call('GET', '/dsh-prompt-optimizer/health')
check('GET /health -> 200 ok', health.status === 200 && health.payload.ok === true, JSON.stringify(health.payload))
check(
  'GET /health reports model + llm',
  health.payload.model === 'deepseek-account/deepseek-flash' && health.payload.llm === true,
  JSON.stringify(health.payload),
)
check('GET /health is uncached JSON', /no-store/.test(health.headers['cache-control'] ?? ''), JSON.stringify(health.headers))

// 2. health via the empty suffix (prefix tolerance)
const healthBare = await call('GET', '/dsh-prompt-optimizer')
check('GET /dsh-prompt-optimizer -> health', healthBare.payload.ok === true, JSON.stringify(healthBare.payload))

// 3. unknown subpath
const missing = await call('GET', '/dsh-prompt-optimizer/nope')
check('unknown subpath -> 404 NOT_FOUND', missing.status === 404 && missing.payload.error === 'NOT_FOUND', JSON.stringify(missing.payload))

// 4. wrong method on optimize
const wrong = await call('GET', '/dsh-prompt-optimizer/optimize')
check('GET /optimize -> 405', wrong.status === 405 && wrong.payload.error === 'METHOD_NOT_ALLOWED', JSON.stringify(wrong.payload))

// 5. malformed JSON
{
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize')
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from('{oops', 'utf8')
  }
  const res = makeResponse()
  await registered.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('bad JSON -> 400 BAD_REQUEST', res.record.status === 400 && payload.error === 'BAD_REQUEST', res.record.body)
}

// 6. empty draft
const empty = await call('POST', '/dsh-prompt-optimizer/optimize', { text: '   ' })
check('empty draft -> EMPTY', empty.payload.ok === false && empty.payload.error === 'EMPTY', JSON.stringify(empty.payload))

// 7. oversized draft (config maxChars=200 floor)
{
  const strict = makeContext()
  apply(strict, { maxChars: 200 })
  const strictRoute = strict.state.route
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'x'.repeat(201) })
  const res = makeResponse()
  await strictRoute.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('over maxChars -> TOO_LONG', payload.ok === false && payload.error === 'TOO_LONG', res.record.body)
}

// 8. happy path, default config
const ok = await call('POST', '/dsh-prompt-optimizer/optimize', { text: '写个登录页', locale: 'zh' })
check('optimize -> ok with text', ok.payload.ok === true && ok.payload.text === 'OPTIMIZED', JSON.stringify(ok.payload))
check('optimize reports model + elapsed', typeof ok.payload.elapsedMs === 'number' && ok.payload.model === 'deepseek-account/deepseek-flash', JSON.stringify(ok.payload))

// 9. the model request shape
const sent = ctx.state.lastRequest
check('request carries session identity, system, temperature', Boolean(sent) && sent.sessionId === 'dsh-prompt-optimizer' && typeof sent.system === 'string' && sent.temperature === 0.6, JSON.stringify({ sessionId: sent?.sessionId, temperature: sent?.temperature, systemLen: sent?.system?.length }))
check('request uses the user message + provider/model', sent.messages?.[0]?.role === 'user' && sent.provider === 'deepseek-account' && sent.model === 'deepseek-flash', JSON.stringify({ provider: sent?.provider, model: sent?.model }))
check('reasoning off only when declared', sent.reasoningEffort === 'off' && ctx.state.modelInfoCalls === 1, JSON.stringify({ effort: sent.reasoningEffort, calls: ctx.state.modelInfoCalls }))

// 10. fence + label cleaning
{
  const fenced = makeContext({ streamText: '```text\n优化后的提示词：你好\n```' })
  apply(fenced, {})
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
  const res = makeResponse()
  await fenced.state.route.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('strips fence and label', payload.ok === true && payload.text === '你好', res.record.body)
}

// 11. model failure
{
  const broken = makeContext({ streamError: new Error('upstream exploded') })
  apply(broken, {})
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
  const res = makeResponse()
  await broken.state.route.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('stream error -> GENERATE_FAILED', payload.ok === false && payload.error === 'GENERATE_FAILED' && /exploded/.test(payload.message), res.record.body)
}

// 12. empty model answer
{
  const silent = makeContext({ chunks: [] })
  apply(silent, {})
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
  const res = makeResponse()
  await silent.state.route.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('no text -> GENERATE_FAILED', payload.ok === false && payload.error === 'GENERATE_FAILED', res.record.body)
}

// 13. no model configured
{
  const modelless = makeContext()
  modelless.agentDefaultModel = { currentSelection: () => undefined }
  apply(modelless, {})
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
  const res = makeResponse()
  await modelless.state.route.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('no selection -> NO_MODEL', payload.ok === false && payload.error === 'NO_MODEL', res.record.body)
}

// 14. no llm service
{
  const llmless = { ...makeContext(), llm: undefined, get: () => undefined }
  apply(llmless, {})
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
  const res = makeResponse()
  await llmless.state.route.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('missing llm -> NO_LLM', payload.ok === false && payload.error === 'NO_LLM', res.record.body)
}

// 15. concurrency guard: two slow calls hold the two slots, a third is BUSY
{
  const slow = makeContext({ chunks: [{ type: 'text', text: 'late' }] })
  const waiting = []
  slow.llm.stream = async function* () {
    await new Promise(resolve => {
      waiting.push(resolve)
    })
    yield { type: 'text', text: 'late' }
  }
  apply(slow, {})
  const pending = []
  for (let index = 0; index < 2; index += 1) {
    const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
    const res = makeResponse()
    pending.push(slow.state.route.handler(req, res).then(() => JSON.parse(res.record.body)))
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  const third = await (async () => {
    const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
    const res = makeResponse()
    await slow.state.route.handler(req, res)
    return JSON.parse(res.record.body)
  })()
  check('third concurrent call -> BUSY', third.ok === false && third.error === 'BUSY', JSON.stringify(third))
  for (const release of waiting) release()
  const settled = await Promise.all(pending)
  check('held calls still finish', settled.every(payload => payload.ok === true), JSON.stringify(settled))
}

// 16. the default-model service is reachable by name even when it is not a ctx property
{
  const named = makeContext()
  const selection = named.agentDefaultModel
  delete named.agentDefaultModel
  named.get = name => (name === 'llm' ? named.llm : name === 'agentDefaultModel' ? selection : undefined)
  apply(named, {})
  const req = makeRequest('POST', '/dsh-prompt-optimizer/optimize', { text: 'hi' })
  const res = makeResponse()
  await named.state.route.handler(req, res)
  const payload = JSON.parse(res.record.body)
  check('selection via ctx.get -> ok', payload.ok === true && payload.model === 'deepseek-account/deepseek-flash', res.record.body)
}

const failed = results.filter(result => !result.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
