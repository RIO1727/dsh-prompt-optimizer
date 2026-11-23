/**
 * Offline harness for the Client half: loads client.js the way the Harness
 * module loader does, then drives apply() and the two components with a stub
 * React and a stub service container.
 */
import { readFile } from 'node:fs/promises'

const results = []
function check(name, passed, detail) {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${passed ? '' : '  <- ' + detail}`)
}

/** Minimal hook runtime: enough for one synchronous render of these components. */
const hookState = { cells: [], index: 0, effects: [] }
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const cell = hookState.cells[hookState.index] ?? { value: typeof initial === 'function' ? initial() : initial }
    hookState.cells[hookState.index] = cell
    hookState.index += 1
    return [
      cell.value,
      next => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
      },
    ]
  },
  useEffect(fn) {
    hookState.effects.push(fn)
    hookState.index += 1
  },
  useRef(initial) {
    const cell = hookState.cells[hookState.index] ?? { value: { current: initial } }
    hookState.cells[hookState.index] = cell
    hookState.index += 1
    return cell.value
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    hookState.index += 1
    return getSnapshot()
  },
}

function render(Component, props) {
  hookState.cells = []
  hookState.index = 0
  hookState.effects = []
  const element = Component(props)
  for (const effect of hookState.effects) effect()
  return element
}

/** Render one tree, resolving wrapper components until an intrinsic element is on top. */
function mount(Component, props) {
  let element = render(Component, props)
  let depth = 0
  while (element && typeof element.type === 'function' && depth < 8) {
    element = render(element.type, element.props)
    depth += 1
  }
  return element
}

/** Find the first descendant element matching `predicate`. */
function find(element, predicate) {
  if (!element || typeof element !== 'object') return undefined
  if (predicate(element)) return element
  for (const child of element.children ?? []) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return undefined
}

function textOf(element) {
  if (element === null || element === undefined) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  return (element.children ?? []).map(textOf).join('')
}

// --- Load the client half through the same loader contract the GUI uses ------
let exported
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      exported = { id, value: factory(name => (name === 'react' ? React : undefined)) }
    },
  },
}
new Function('window', 'document', 'navigator', source)(window, undefined, { language: 'zh-CN' })

check('module registers itself with the loader', exported?.id === 'dsh-prompt-optimizer', String(exported?.id))
check('module exports inject + apply', Array.isArray(exported.value.inject) && typeof exported.value.apply === 'function', JSON.stringify(Object.keys(exported.value ?? {})))
check('module injects the slots service', exported.value.inject.includes('slots'), JSON.stringify(exported.value.inject))

// --- Stub services -----------------------------------------------------------
const registered = []
const localeCalls = []
const drafts = { value: '', rev: 3 }
const inputHandle = {
  state: { getSnapshot: () => ({ draft: drafts.value, draftRev: drafts.rev, phase: 'plain' }) },
  setDraft(text) {
    drafts.value = text
    drafts.rev += 1
    return true
  },
}
const ctx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject(name, callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register(options, Component) {
      registered.push({ options, Component })
      return () => {
        const at = registered.findIndex(entry => entry.options.id === options.id)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  },
  locale: {
    register(namespace, id, dictionary) {
      localeCalls.push({ namespace, id, keys: Object.keys(dictionary).length })
    },
    bind() {
      return key => (key === 'button.label' ? '优化提示词' : '')
    },
    subscribe() {
      return () => {}
    },
  },
  sessions: { scope: id => (id === 'session-1' ? { id: 'session-1' } : undefined) },
  conversation: { input: { for: actx => (actx && actx.id === 'session-1' ? inputHandle : undefined) } },
  get(name) {
    return this[name]
  },
}
exported.value.apply(ctx)

check('registers two slot entries', registered.length === 2, JSON.stringify(registered.map(entry => entry.options.id)))
check('one entry per surface', registered.some(entry => entry.options.name === 'conversation.input.right') && registered.some(entry => entry.options.name === 'conversation.composer.dock'), JSON.stringify(registered.map(entry => entry.options.name)))
check('registers both locales', localeCalls.length === 2 && localeCalls.every(call => call.namespace === 'dsh-prompt-optimizer'), JSON.stringify(localeCalls))

const buttonEntry = registered.find(entry => entry.options.name === 'conversation.input.right')
const dockEntry = registered.find(entry => entry.options.name === 'conversation.composer.dock')

// --- The button --------------------------------------------------------------
const buttonProps = { ...buttonEntry.options.inject('session-1'), ctx }
const element = mount(buttonEntry.Component, buttonProps)
const button = find(element, node => node.type === 'button')
check('renders a button', Boolean(button), JSON.stringify(element?.type))
check('button carries the label + tooltip', button?.props['aria-label'] === '优化提示词' && typeof button?.props.title === 'string', JSON.stringify(button?.props ?? {}))
check('button starts idle', button?.props['data-phase'] === 'idle', JSON.stringify(button?.props))
check('button renders the sparkle svg', find(element, node => node.type === 'svg') !== undefined, 'no svg')

// Empty draft: click publishes a notice instead of calling the model.
const fetchCalls = []
await button.props.onClick()
check('empty draft does not call fetch', fetchCalls.length === 0, JSON.stringify(fetchCalls))

// The dock renders whatever the store holds.
const dockProps = { ...dockEntry.options.inject('session-1'), ctx }
const dock = mount(dockEntry.Component, dockProps)
check('dock shows the empty-draft notice', /还是空的/.test(textOf(dock)), textOf(dock))
const dismiss = find(dock, node => node.type === 'button' && node.props.className === 'dpo-dock-close')
check('dock offers a dismiss control', Boolean(dismiss), 'no close button')

// Successful optimization: stub fetch, then click with a real draft.
drafts.value = '  写个登录页  '
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init })
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, text: '请实现一个登录页。', model: 'deepseek-account/deepseek-flash', elapsedMs: 12 }
    },
  }
}
const element2 = mount(buttonEntry.Component, buttonProps)
const button2 = find(element2, node => node.type === 'button')
await button2.props.onClick()
check('posts the trimmed draft to the plugin route', fetchCalls.length === 1 && /dsh-prompt-optimizer\/optimize$/.test(String(fetchCalls[0]?.url ?? '')) && JSON.parse(fetchCalls[0].init.body).text === '写个登录页', JSON.stringify(fetchCalls.map(call => call.url)))
check('replaces the draft on success', drafts.value === '请实现一个登录页。', JSON.stringify(drafts.value))

const dock2 = mount(dockEntry.Component, dockProps)
check('dock confirms success', /已优化/.test(textOf(dock2)), textOf(dock2))
const undo = find(dock2, node => node.type === 'button' && node.props.className === 'dpo-dock-action')
check('dock offers undo', Boolean(undo) && /撤销/.test(textOf(undo)), 'no undo')
undo.props.onClick()
check('undo restores the original draft', drafts.value === '  写个登录页  ', JSON.stringify(drafts.value))

// Stale revision: the draft changed while the request was in flight.
drafts.value = '旧草稿'
drafts.rev = 7
let releaseFetch
globalThis.fetch = async () => {
  await new Promise(resolve => {
    releaseFetch = resolve
  })
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, text: '请实现一个登录页。', model: 'deepseek-account/deepseek-flash', elapsedMs: 12 }
    },
  }
}
const element3 = mount(buttonEntry.Component, buttonProps)
const button3 = find(element3, node => node.type === 'button')
const clicking = button3.props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
check('request is held open by the stub', typeof releaseFetch === 'function', String(typeof releaseFetch))
drafts.value = '我改过的草稿'
drafts.rev = 8
releaseFetch()
await clicking
check('stale draft is not overwritten', drafts.value === '我改过的草稿', JSON.stringify(drafts.value))
const dock3 = mount(dockEntry.Component, dockProps)
check('dock warns about the edit', /没有覆盖/.test(textOf(dock3)), textOf(dock3))
const replace = find(dock3, node => node.type === 'button' && node.props.className === 'dpo-dock-action')
check('dock offers replace anyway', Boolean(replace) && /仍然替换/.test(textOf(replace)), 'no replace')
replace.props.onClick()
check('replace anyway applies the result', drafts.value === '请实现一个登录页。', JSON.stringify(drafts.value))

// Host error surfaces verbatim.
drafts.value = '出错的草稿'
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { ok: false, error: 'GENERATE_FAILED', message: 'upstream exploded' }
  },
})
const element4 = mount(buttonEntry.Component, buttonProps)
await find(element4, node => node.type === 'button').props.onClick()
const dock4 = mount(dockEntry.Component, dockProps)
check('host error reaches the dock', /upstream exploded/.test(textOf(dock4)), textOf(dock4))

const failed = results.filter(result => !result.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
