/**
 * dsh-prompt-optimizer — Host half.
 *
 * Owns the only thing the browser cannot do: call the model. The Client half
 * (client.js) reads the composer draft, posts it to `/dsh-prompt-optimizer/optimize`
 * and writes the rewritten text back into the composer. Everything here is
 * request-scoped: no session events are appended, no agent is woken, and the
 * conversation log is never touched — an optimization is a pure function of the
 * draft text the user asked about.
 *
 * The model call reuses the Harness `llm` service with the surrounding
 * conversation's own provider/model (`agentDefaultModel.currentSelection()`), so
 * a user who already configured a provider needs no extra credentials.
 */
/**
 * The Harness LLM helpers are loaded lazily on purpose.
 *
 * The loader maps a bare `@deepseek-ai/*` request to the running installation
 * only when the importing package declares that name in `peerDependencies`, so
 * that row is what makes this import resolve at all. Keeping it dynamic means a
 * runtime that cannot satisfy it still mounts the plugin: `/health` answers, and
 * an optimization reports `NO_LLM_RUNTIME` instead of the whole bundle failing
 * to import (which is how a static import blows up the loader entry).
 */
let llmModulePromise

function loadLlmModule() {
  if (llmModulePromise === undefined) {
    llmModulePromise = import('@deepseek-ai/dsh-llm')
    llmModulePromise.catch(() => {
      llmModulePromise = undefined
    })
  }
  return llmModulePromise
}

/** True when the Harness LLM helpers can be loaded in this runtime. */
async function llmRuntimeAvailable() {
  try {
    await loadLlmModule()
    return true
  } catch {
    return false
  }
}

/** Route prefix owned by this plugin; the Client resolves it against the page base. */
const ROUTE_PREFIX = '/dsh-prompt-optimizer'

/**
 * Stable call identity handed to the adapter that turns a request into
 * provider traffic (some routes need a session-shaped header). It only has to
 * be stable — it is not a real conversation id.
 */
const CALL_IDENTITY = 'dsh-prompt-optimizer'

/** Plugin version, mirrored into `/health` for support reports. */
const VERSION = '1.0.2'

/** Hard ceiling on one request body, so a hostile page cannot balloon memory. */
const MAX_BODY_BYTES = 256 * 1024

/** Requests handled at once before newcomers are refused with `BUSY`. */
const MAX_IN_FLIGHT = 2

/**
 * The `webServer` route is the only hard dependency: without it there is no
 * transport. `llm` and `agentDefaultModel` are resolved by name at call time so a
 * trimmed-down host degrades to an error notice instead of blocking the bundle.
 */
export const inject = ['webServer']

/** System prompt: Chinese draft path. */
const SYSTEM_ZH = [
  '你是一位资深提示词工程师。用户会把他在 AI 对话输入框里正在写的草稿发给你，你要把它改写成一条更清晰、更可执行的提示词。',
  '',
  '硬性规则：',
  '- 只输出改写后的提示词正文，不要解释、开场白、结尾语，不要用引号或代码块包起来。',
  '- 忠实原意：不新增用户没给出的事实、数字、路径、名称和约束，不替用户做决定，不扩大也不缩小需求范围。',
  '- 补全可执行性：目标要明确，必要的背景、约束、验收标准和产出形式要写清楚；把冗余和口语废话压缩掉。',
  '- 语言一致：用户用中文写就用中文，用英文写就用英文；专有名词、代码、命令、路径保持原样。',
  '- 克制篇幅：一般不超过原文的 2.5 倍，一句话的草稿不要膨胀成小作文；只在确实需要时使用分点或标题。',
  '- 草稿本身已经很好时，只做最小必要润色，不要为了改而改。',
  '- 不要添加“如果还有问题请告诉我”“请确认”这类客套话。',
  '- 草稿里的代码块、URL、@文件引用原样保留。',
  '- 需要分行时直接换行；不要输出字面量 \n，也不要把整段提示词包进行内代码。',
].join('\n')

/** System prompt: English draft path. */
const SYSTEM_EN = [
  'You are a senior prompt engineer. The user sends the draft they are typing into an AI chat composer; rewrite it into a clearer, more executable prompt.',
  '',
  'Hard rules:',
  '- Output the rewritten prompt only. No preamble, no explanation, no surrounding quotes or code fences.',
  '- Stay faithful: invent no facts, numbers, paths, names or constraints the user did not supply; do not make decisions for them; do not widen or narrow the scope.',
  '- Make it executable: state the goal, the needed context, the constraints, the acceptance criteria and the expected output form; compress redundancy and filler.',
  '- Keep the language: Chinese drafts stay Chinese, English drafts stay English. Keep proper nouns, code, commands and paths verbatim.',
  '- Stay restrained: usually no more than 2.5x the original length; a one-line draft must not become an essay. Use lists or headings only when they genuinely help.',
  '- If the draft is already good, make the smallest necessary polish instead of rewriting it.',
  '- Add no closing pleasantries such as "let me know if you need anything else".',
  '- Preserve code blocks, URLs and @file references exactly.',
  '- Use real line breaks, not literal \n escapes, and never wrap the whole prompt in an inline code span.',
].join('\n')

/** Clamp a configured number into a usable range. */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Read the live config defensively: an absent or partial row still works. */
function readOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  return {
    maxChars: clampInt(raw.maxChars, 200, 40000, 12000),
    timeoutMs: clampInt(raw.timeoutMs, 5000, 300000, 90000),
    temperature: (() => {
      const t = Number(raw.temperature)
      return Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.6
    })(),
    // 'off' asks for no extended thinking (faster rewrites); 'keep' inherits the
    // model default. 'off' is only sent when the model declares support for it.
    reasoning: raw.reasoning === 'keep' ? 'keep' : 'off',
    provider: provider === '' ? undefined : provider,
    model: model === '' ? undefined : model,
  }
}

/** The session's own model selection, when the service is present. */
function currentSelection(ctx) {
  const service = modelSelectionOf(ctx)
  if (!service) return undefined
  try {
    const picked = service.currentSelection()
    if (picked && typeof picked.provider === 'string' && typeof picked.model === 'string') {
      return { provider: picked.provider, model: picked.model }
    }
  } catch {
    /* a stripped-down host: the caller reports NO_MODEL instead */
  }
  return undefined
}

/**
 * Resolve the default-model service without adding a hard dependency: an
 * injected `agentDefaultModel` is used directly, and a context that only exposes
 * `get()` is asked for it by name.
 */
function modelSelectionOf(ctx) {
  try {
    const direct = ctx.agentDefaultModel
    if (direct && typeof direct.currentSelection === 'function') return direct
  } catch {
    /* not injected in this host: fall through to the named lookup */
  }
  try {
    const looked = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : undefined
    if (looked && typeof looked.currentSelection === 'function') return looked
  } catch {
    /* a strict context refuses unknown services */
  }
  return undefined
}

/** Resolve `ctx.llm` without assuming the service is mounted or injectable. */
function llmOf(ctx) {
  try {
    const direct = ctx.llm
    if (direct && typeof direct.stream === 'function') return direct
  } catch {
    /* not mounted yet: the optional lookup below reports NO_LLM instead */
  }
  try {
    const looked = typeof ctx.get === 'function' ? ctx.get('llm', false) : undefined
    if (looked && typeof looked.stream === 'function') return looked
  } catch {
    /* a strict context refuses unknown services */
  }
  return undefined
}

/** Whether the model declares a reasoning `off` level; omission is the safe default. */
async function supportsReasoningOff(llm, provider, model) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const efforts = info?.reasoning?.efforts
    return Array.isArray(efforts) && efforts.some(effort => effort && effort.id === 'off')
  } catch {
    return false
  }
}

/**
 * Some models answer with the two characters `\` `n` where a line break belongs.
 * Swap those for real newlines, but leave code spans and fenced blocks alone:
 * inside code a backslash-n can be part of a regex or a string literal.
 */
function unescapeNewlines(text) {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/\\r\\n|\\n/g, '\n'),
    )
    .join('')
}

/** Strip a wrapping code fence or a stray "optimized prompt:" label. */
function cleanOutput(raw) {
  let text = String(raw ?? '').trim()
  const fenced = text.match(/^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/)
  if (fenced) text = fenced[1].trim()
  const labeled = text.match(/^(?:优化后(?:的)?提示词|改写后(?:的)?提示词|optimized prompt|rewritten prompt)\s*[:：]\s*/i)
  if (labeled) text = text.slice(labeled[0].length).trim()
  return unescapeNewlines(text)
}

/** One JSON answer with no caching. */
function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a request body, refusing anything over {@link MAX_BODY_BYTES}. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Ask the model to rewrite one draft.
 * @returns `{ ok: true, text }` or `{ ok: false, error, message }` — never throws.
 */
async function optimize(ctx, options, text, locale, signal) {
  const llm = llmOf(ctx)
  const selection = currentSelection(ctx)
  const provider = options.provider ?? selection?.provider
  const model = options.model ?? selection?.model
  if (!provider || !model) {
    return { ok: false, error: 'NO_MODEL', message: 'the current conversation has no model configured' }
  }
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: 'NO_LLM', message: 'the llm service is unavailable' }
  }
  const system = locale === 'en' ? SYSTEM_EN : SYSTEM_ZH
  const off = options.reasoning === 'off' && (await supportsReasoningOff(llm, provider, model))
  let helpers
  try {
    helpers = await loadLlmModule()
  } catch (error) {
    return {
      ok: false,
      error: 'NO_LLM_RUNTIME',
      message: `the Harness LLM helpers are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const { BlockAssembler, createUserMessage } = helpers
  const request = {
    provider,
    model,
    sessionId: CALL_IDENTITY,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    ],
    system,
    temperature: options.temperature,
    ...(off ? { reasoningEffort: 'off' } : {}),
    signal,
  }
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of llm.stream(request)) assembler.push(chunk)
  } catch (error) {
    return {
      ok: false,
      error: 'GENERATE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const text_ = assembler
    .blocks()
    .filter(block => block && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('')
  const optimized = cleanOutput(text_)
  if (optimized === '') {
    const finish = assembler.finish
    const reason =
      finish && typeof finish === 'object' && finish.failure && typeof finish.failure.message === 'string'
        ? finish.failure.message
        : 'the model returned no text'
    return { ok: false, error: 'GENERATE_FAILED', message: reason }
  }
  return { ok: true, text: optimized, provider, model }
}

/**
 * Host half entry point.
 * @param ctx - Cordis context carrying `webServer` and (optionally) `llm`.
 * @param config - optional row config: maxChars, timeoutMs, temperature, reasoning,
 *   provider, model. Everything has a working default.
 */
export function apply(ctx, config) {
  const options = readOptions(config)
  let inFlight = 0

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')

          if (rest === 'health' || rest === '') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'use GET' })
              return
            }
            const selection = currentSelection(ctx)
            const provider = options.provider ?? selection?.provider
            const model = options.model ?? selection?.model
            sendJson(res, 200, {
              ok: true,
              version: VERSION,
              route: ROUTE_PREFIX,
              llm: Boolean(llmOf(ctx)),
              llmRuntime: await llmRuntimeAvailable(),
              model: provider && model ? `${provider}/${model}` : null,
              maxChars: options.maxChars,
            })
            return
          }

          if (rest !== 'optimize') {
            sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: `unknown route: ${rest}` })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'use POST' })
            return
          }

          let payload
          try {
            const raw = await readBody(req)
            payload = raw === '' ? {} : JSON.parse(raw)
          } catch (error) {
            const tooLarge = error && error.code === 'BODY_TOO_LARGE'
            sendJson(res, tooLarge ? 413 : 400, {
              ok: false,
              error: tooLarge ? 'BODY_TOO_LARGE' : 'BAD_REQUEST',
              message: tooLarge ? 'request body too large' : 'invalid JSON body',
            })
            return
          }
          const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
          const locale = payload?.locale === 'en' ? 'en' : payload?.locale === 'zh' ? 'zh' : 'auto'
          if (text === '') {
            sendJson(res, 200, { ok: false, error: 'EMPTY', message: 'the draft is empty' })
            return
          }
          if (text.length > options.maxChars) {
            sendJson(res, 200, {
              ok: false,
              error: 'TOO_LONG',
              message: `the draft is longer than ${options.maxChars} characters`,
              maxChars: options.maxChars,
            })
            return
          }
          if (inFlight >= MAX_IN_FLIGHT) {
            sendJson(res, 200, { ok: false, error: 'BUSY', message: 'another optimization is still running' })
            return
          }

          const controller = new AbortController()
          const onClose = () => controller.abort()
          res.on('close', onClose)
          const timeout = AbortSignal.timeout(options.timeoutMs)
          const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([controller.signal, timeout]) : timeout
          inFlight += 1
          const startedAt = Date.now()
          try {
            const result = await optimize(ctx, options, text, locale, signal)
            if (!result.ok) {
              sendJson(res, 200, result)
              return
            }
            sendJson(res, 200, {
              ok: true,
              text: result.text,
              model: `${result.provider}/${result.model}`,
              elapsedMs: Date.now() - startedAt,
            })
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              error: 'INTERNAL',
              message: error instanceof Error ? error.message : String(error),
            })
          } finally {
            inFlight = Math.max(0, inFlight - 1)
            res.off('close', onClose)
          }
        },
      }),
    'dsh-prompt-optimizer: /dsh-prompt-optimizer route',
  )
}
