/**
 * dsh-prompt-optimizer — Client half.
 *
 * Two registrations, one shared store:
 *  - `conversation.input.right` — the sparkle button. That slot is the row of
 *    compact controls immediately BEFORE the composer submit action, which is
 *    where a "polish my prompt" affordance belongs (Work Buddy places its AI
 *    optimizer there too).
 *  - `conversation.composer.dock` — an ambient status strip below the composer
 *    card: success with Undo, or the failure reason. It owns every piece of
 *    text the button cannot show without clipping inside the tool row.
 *
 * The draft is read and written through the conversation service the Harness
 * exposes to Client plugins (`conversation.input.for(sessionScope)`), so the
 * plugin never touches DOM owned by the composer.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace and module identity. */
    const NS = 'dsh-prompt-optimizer'

    /** Style element id, so a hot reload replaces instead of stacking sheets. */
    const STYLE_ID = 'dsh-prompt-optimizer-styles'

    /** Characters the browser accepts before asking the user to trim. */
    const MAX_CHARS = 12000

    /** HTTP wait budget; the Host aborts its own model call at 90s. */
    const REQUEST_TIMEOUT_MS = 110000

    const ZH = {
      'button.label': '优化提示词',
      'button.tooltip': '用 AI 把当前输入改写成更清晰、更可执行的提示词（不会发送）',
      'notice.empty': '输入框还是空的，先写点什么再优化。',
      'notice.command': '斜杠命令模式下不支持优化，先把命令清掉。',
      'notice.noInput': '没找到当前会话的输入框，请刷新页面再试。',
      'notice.tooLong': '输入超过 {max} 字，先精简一下再优化。',
      'notice.busy': '上一条优化还没结束，稍等一下。',
      'notice.success': '已优化，可以直接发送，也可以撤销。',
      'notice.undo': '撤销',
      'notice.error': '优化失败：{message}',
      'notice.changed': '你等待时输入框被改动过，结果没有覆盖上去。',
      'notice.replace': '仍然替换',
      'notice.close': '关闭提示',
    }

    const EN = {
      'button.label': 'Optimize prompt',
      'button.tooltip': 'Rewrite the current draft into a clearer, more executable prompt (nothing is sent)',
      'notice.empty': 'The composer is empty — write something first.',
      'notice.command': 'Prompt optimization is unavailable while a slash command owns the draft.',
      'notice.noInput': 'Could not reach this conversation’s composer. Reload the page and retry.',
      'notice.tooLong': 'The draft is over {max} characters — trim it first.',
      'notice.busy': 'The previous optimization is still running.',
      'notice.success': 'Optimized. Send it, or undo.',
      'notice.undo': 'Undo',
      'notice.error': 'Optimization failed: {message}',
      'notice.changed': 'The draft changed while you waited, so the result was not applied.',
      'notice.replace': 'Replace anyway',
      'notice.close': 'Dismiss',
    }

    const DICTS = { zh: ZH, en: EN }

    /** Styles: only `--dsw-alias-*` tokens, so light/dark and skins follow the host. */
    const CSS = `
.dpo-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  padding: 0;
  margin: 0 2px 0 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, transform .12s ease;
  -webkit-tap-highlight-color: transparent;
}
.dpo-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dpo-button:active:not(:disabled) { transform: scale(.92); }
.dpo-button:disabled { cursor: default; opacity: .6; }
.dpo-button[data-phase="loading"] { color: var(--dsw-alias-brand-primary); opacity: 1; }
.dpo-button[data-phase="done"] { color: var(--dsw-alias-state-success-primary); }
.dpo-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dpo-button svg { display: block; pointer-events: none; }
.dpo-spin { animation: dpo-spin 1s linear infinite; transform-origin: 50% 50%; }
@keyframes dpo-spin { to { transform: rotate(360deg); } }

.dpo-dock {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  max-width: 100%;
  box-sizing: border-box;
  margin: 2px 0 6px 2px;
  padding: 5px 8px 5px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
  animation: dpo-rise .16s ease-out;
}
@keyframes dpo-rise { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.dpo-dock[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
.dpo-dock[data-kind="success"] { color: var(--dsw-alias-state-success-primary); }
.dpo-dock[data-kind="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dpo-dock-icon { display: inline-flex; flex: none; }
.dpo-dock-text {
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpo-dock-action {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dpo-dock-action:hover { background: var(--dsw-alias-bg-layer-2); }
.dpo-dock-close {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.dpo-dock-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
@media (prefers-reduced-motion: reduce) {
  .dpo-button, .dpo-dock { transition: none; animation: none; }
  .dpo-spin { animation: none; }
}
`

    /** Best-effort language when the locale service cannot answer. */
    function detectLang() {
      try {
        const tag = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase()
        return tag.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    /** One dictionary lookup, preferring the Harness locale service. */
    function translate(locale, key, params) {
      let raw
      try {
        const bound = locale && typeof locale.bind === 'function' ? locale.bind(NS) : undefined
        if (typeof bound === 'function') raw = bound(key)
      } catch {
        raw = undefined
      }
      if (typeof raw !== 'string' || raw === '' || raw === key) {
        const dict = DICTS[detectLang()]
        raw = dict && typeof dict[key] === 'string' ? dict[key] : key
      }
      if (!params) return raw
      return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Run `fn` as a disposable effect on the module context. */
    function effect(ctx, fn, label) {
      return typeof ctx.effect === 'function' ? ctx.effect(fn, label) : fn()
    }

    /** Resolve a Client service without assuming it is a direct property. */
    function service(ctx, name) {
      try {
        if (ctx[name] !== undefined) return ctx[name]
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    /** Resolve the session's composer input handle, or undefined when unreachable. */
    function composerInput(ctx, sessionId) {
      try {
        const conversation = service(ctx, 'conversation')
        if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') return undefined
        const sessions = service(ctx, 'sessions')
        const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined
        if (!actx) return undefined
        const input = conversation.input.for(actx)
        if (!input || !input.state || typeof input.state.getSnapshot !== 'function') return undefined
        if (typeof input.setDraft !== 'function') return undefined
        return input
      } catch {
        return undefined
      }
    }

    /**
     * The plugin route, resolved against the PAGE base so a reverse-proxy
     * directory prefix survives (a leading slash would pin it to the origin root).
     */
    function routeUrl(path) {
      const clean = String(path || '').replace(/^\/+/, '')
      let base = ''
      try {
        base = (typeof document !== 'undefined' && document.baseURI) || ''
      } catch {
        base = ''
      }
      if (base === '') {
        try {
          base = (typeof location !== 'undefined' && location.href) || ''
        } catch {
          base = ''
        }
      }
      try {
        const url = new URL(base || 'http://localhost/')
        url.search = ''
        url.hash = ''
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(clean, url.href).href
      } catch {
        return '/' + clean
      }
    }

    /** POST the draft and resolve to the Host's JSON answer. */
    async function requestOptimize(text, locale, signal) {
      const url = routeUrl('dsh-prompt-optimizer/optimize')
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, locale }),
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') return { ok: false, error: 'ABORTED', message: 'request aborted' }
        return { ok: false, error: 'NETWORK', message: error instanceof Error ? error.message : String(error) }
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        return { ok: false, error: 'BAD_RESPONSE', message: `HTTP ${response.status}` }
      }
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'BAD_RESPONSE', message: `HTTP ${response.status}` }
      }
      if (!response.ok && payload.ok !== true) {
        return {
          ok: false,
          error: payload.error || 'HTTP_ERROR',
          message: payload.message || `HTTP ${response.status}`,
        }
      }
      return payload
    }

    /** Shared, session-independent notice store read by the dock entry. */
    function createNoticeStore() {
      let snapshot = null
      let seq = 0
      let timer = 0
      const listeners = new Set()
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* one bad subscriber must not starve the others */
          }
        }
      }
      const clear = () => {
        if (timer) {
          clearTimeout(timer)
          timer = 0
        }
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        publish(next) {
          clear()
          seq += 1
          snapshot = next ? { kind: 'info', ...next, seq } : null
          notify()
          if (next) {
            const ttl = next.kind === 'error' ? 10000 : 8000
            timer = setTimeout(() => {
              timer = 0
              snapshot = null
              notify()
            }, ttl)
          }
        },
        dismiss() {
          clear()
          if (snapshot !== null) {
            snapshot = null
            notify()
          }
        },
      }
    }

    const store = createNoticeStore()

    /** Sparkle mark: the "polish with AI" affordance. */
    function SparkleIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M10.4 3.2l1.7 4.1 4.1 1.7-4.1 1.7-1.7 4.1-1.7-4.1L4.6 9l4.1-1.7 1.7-4.1z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M17.9 14.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z',
          fill: 'currentColor',
          opacity: '0.65',
        }),
      )
    }

    /** Same silhouette while a request is in flight. */
    function SpinnerIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true', className: 'dpo-spin' },
        h('circle', { cx: 12, cy: 12, r: 7.5, stroke: 'currentColor', strokeWidth: 2, opacity: '0.25' }),
        h('path', {
          d: 'M12 4.5A7.5 7.5 0 0 1 19.5 12',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
      )
    }

    /** Brief confirmation after the draft was replaced. */
    function CheckIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M5 12.8l4.4 4.2L19 6.6',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Small leading glyph for the dock, by tone. */
    function NoticeIcon(props) {
      if (props.kind === 'success' || props.kind === 'done') return CheckIcon()
      if (props.kind === 'error' || props.kind === 'warn') {
        return h(
          'svg',
          { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
          h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.8 }),
          h('path', { d: 'M12 7.4v5.4', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          h('circle', { cx: 12, cy: 16.4, r: 1.05, fill: 'currentColor' }),
        )
      }
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.8 }),
        h('path', { d: 'M12 10.8v5.2', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 7.9, r: 1.05, fill: 'currentColor' }),
      )
    }

    /** Shared translate hook: re-renders when the locale preference changes. */
    function useTranslate(ctx) {
      const locale = service(ctx, 'locale')
      const [, force] = React.useState(0)
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => force(value => value + 1))
      }, [locale])
      return (key, params) => translate(locale, key, params)
    }

    /** Write one draft, reporting whether the composer accepted it. */
    function applyDraft(input, text) {
      try {
        input.setDraft(text)
        return true
      } catch {
        return false
      }
    }

    /** The composer button registered into `conversation.input.right`. */
    function PromptOptimizerButton(props) {
      const t = useTranslate(props.ctx)
      const sessionId = props.sessionId
      const [phase, setPhase] = React.useState('idle')
      const abortRef = React.useRef(null)
      const doneTimer = React.useRef(0)

      React.useEffect(
        () => () => {
          if (abortRef.current) abortRef.current.abort()
          if (doneTimer.current) clearTimeout(doneTimer.current)
        },
        [],
      )

      const flashDone = () => {
        setPhase('done')
        if (doneTimer.current) clearTimeout(doneTimer.current)
        doneTimer.current = setTimeout(() => {
          doneTimer.current = 0
          setPhase('idle')
        }, 1400)
      }

      const onClick = async () => {
        if (phase === 'loading') return
        const input = composerInput(props.ctx, sessionId)
        if (!input) {
          store.publish({ kind: 'error', text: t('notice.noInput') })
          return
        }
        let snapshot = {}
        try {
          snapshot = input.state.getSnapshot() || {}
        } catch {
          snapshot = {}
        }
        const draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
        const text = draft.trim()
        if (text === '') {
          store.publish({ kind: 'warn', text: t('notice.empty') })
          return
        }
        if (snapshot.phase === 'claimed' || snapshot.phase === 'submitting' || snapshot.phase === 'adjudicating') {
          store.publish({ kind: 'warn', text: t('notice.command') })
          return
        }
        if (draft.length > MAX_CHARS) {
          store.publish({ kind: 'warn', text: t('notice.tooLong', { max: MAX_CHARS }) })
          return
        }

        const revision = snapshot.draftRev
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        abortRef.current = controller
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : 0
        setPhase('loading')
        let result
        try {
          result = await requestOptimize(text, 'auto', controller ? controller.signal : undefined)
        } finally {
          if (timer) clearTimeout(timer)
          abortRef.current = null
        }

        if (!result.ok) {
          setPhase('idle')
          const message =
            result.error === 'BUSY'
              ? t('notice.busy')
              : result.error === 'TOO_LONG'
                ? t('notice.tooLong', { max: MAX_CHARS })
                : t('notice.error', { message: result.message || result.error })
          store.publish({ kind: 'error', text: message })
          return
        }

        const optimized = typeof result.text === 'string' ? result.text.trim() : ''
        if (optimized === '') {
          setPhase('idle')
          store.publish({ kind: 'error', text: t('notice.error', { message: 'empty response' }) })
          return
        }

        let current = {}
        try {
          current = input.state.getSnapshot() || {}
        } catch {
          current = {}
        }
        const changed =
          revision !== undefined &&
          typeof current.draftRev === 'number' &&
          current.draftRev !== revision
        if (changed) {
          setPhase('idle')
          store.publish({
            kind: 'warn',
            text: t('notice.changed'),
            actions: [
              {
                label: t('notice.replace'),
                run: () => {
                  if (!applyDraft(input, optimized)) return
                  store.publish({
                    kind: 'success',
                    text: t('notice.success'),
                    actions: [{ label: t('notice.undo'), run: () => applyDraft(input, draft) }],
                  })
                  flashDone()
                },
              },
            ],
          })
          return
        }

        if (!applyDraft(input, optimized)) {
          setPhase('idle')
          store.publish({ kind: 'error', text: t('notice.error', { message: 'composer rejected the write' }) })
          return
        }
        flashDone()
        store.publish({
          kind: 'success',
          text: t('notice.success'),
          actions: [{ label: t('notice.undo'), run: () => applyDraft(input, draft) }],
        })
      }

      const label = phase === 'loading' ? t('button.label') + '…' : t('button.label')
      return h(
        'button',
        {
          type: 'button',
          className: 'dpo-button',
          'data-phase': phase,
          title: t('button.tooltip'),
          'aria-label': label,
          'aria-busy': phase === 'loading' ? 'true' : 'false',
          disabled: phase === 'loading',
          onClick,
        },
        phase === 'loading' ? SpinnerIcon() : phase === 'done' ? CheckIcon() : SparkleIcon(),
      )
    }

    /** The dock entry: the one place with room for a sentence and two buttons. */
    function NoticeDock(props) {
      const t = useTranslate(props.ctx)
      const notice = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
      if (!notice) return null
      const children = [
        h('span', { className: 'dpo-dock-icon', key: 'icon' }, h(NoticeIcon, { kind: notice.kind })),
        h('span', { className: 'dpo-dock-text', key: 'text', title: notice.text }, notice.text),
      ]
      const actions = Array.isArray(notice.actions) ? notice.actions : []
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]
        if (!action || typeof action.run !== 'function') continue
        children.push(
          h(
            'button',
            {
              key: 'action-' + index,
              type: 'button',
              className: 'dpo-dock-action',
              onClick: () => {
                try {
                  action.run()
                } catch {
                  /* an action failure must not kill the dock */
                }
              },
            },
            String(action.label || ''),
          ),
        )
      }
      children.push(
        h(
          'button',
          {
            key: 'close',
            type: 'button',
            className: 'dpo-dock-close',
            title: t('notice.close'),
            'aria-label': t('notice.close'),
            onClick: () => store.dismiss(),
          },
          '×',
        ),
      )
      return h('div', { className: 'dpo-dock', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, ...children)
    }

    /** Install the stylesheet once per page, replacing a stale sheet on reload. */
    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const previous = document.getElementById(STYLE_ID)
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous)
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        if (element.parentNode) element.parentNode.removeChild(element)
      }
    }

    /** Wrap a component so the module context reaches it without shadowing slot props. */
    function withContext(Component, ctx) {
      return function SlotEntry(props) {
        return h(Component, Object.assign({}, props, { ctx }))
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        effect(ctx, installStyles, 'dsh-prompt-optimizer: styles')

        const locale = service(ctx, 'locale')
        if (locale && typeof locale.register === 'function') {
          for (const id of Object.keys(DICTS)) {
            effect(ctx, () => locale.register(NS, id, DICTS[id]), `${NS}: locale ${id}`)
          }
        }

        const slots = service(ctx, 'slots')
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.error('[dsh-prompt-optimizer] the slots service is unavailable; no UI registered')
          return
        }

        effect(
          ctx,
          () =>
            slots.inject('conversation.input.right', () =>
              slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'dsh-prompt-optimizer',
                  order: 10,
                  registrant: 'dsh-prompt-optimizer',
                  inject: sessionId => ({ sessionId }),
                },
                withContext(PromptOptimizerButton, ctx),
              ),
            ),
          'dsh-prompt-optimizer: composer button',
        )

        effect(
          ctx,
          () =>
            slots.inject('conversation.composer.dock', () =>
              slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'dsh-prompt-optimizer-notice',
                  order: 10,
                  registrant: 'dsh-prompt-optimizer',
                  inject: sessionId => ({ sessionId }),
                },
                withContext(NoticeDock, ctx),
              ),
            ),
          'dsh-prompt-optimizer: notice dock',
        )
      },
    }
  },
})
