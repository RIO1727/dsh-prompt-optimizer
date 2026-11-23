# dsh-prompt-optimizer

[简体中文](./README.zh-CN.md) · English

An **AI prompt optimizer for the [DeepSeek Harness](https://github.com/deepseek-ai) composer** — a sparkle button that sits right next to **Send**, just like the prompt-optimizing affordance in Work Buddy. One click turns the half-formed thought in your input box into a prompt that is actually executable, then drops it back into the composer where you can send it or undo it.

```
┌─────────────────────────────────────────────┐
│  your rough draft…                          │
│                              ✨  ➤          │  ← ✨ = Optimize prompt, ➤ = Send
└─────────────────────────────────────────────┘
  ✓ Optimized. Send it, or undo.   [Undo] [×]
```

Nothing is sent to the model as a conversation turn: the optimizer talks to the model out-of-band, and only rewrites the text you are still editing.

## What it does

- **Adds one button, immediately left of Send.** It lives in the `conversation.input.right` slot — the Harness's own "compact controls before the submit action" row — so it follows the composer in every theme, density and viewport.
- **Rewrites the draft, not your session.** The current draft goes to the model with a prompt-engineer system prompt; the rewritten prompt comes back and replaces the draft in place. No message is appended to the conversation and no tokens are spent on a turn you did not ask for.
- **Faithful by construction.** The system prompt forbids inventing facts, numbers, paths or constraints, forbids widening or narrowing scope, keeps the draft's language, and preserves code blocks, URLs and `@file` references verbatim.
- **Undo in one click.** A status strip under the composer offers **Undo**, which restores the exact original draft.
- **Never clobbers your typing.** If you edit the draft while the request is in flight, the result is *not* applied; instead you get a notice with an explicit **Replace anyway** action.
- **Honest failure.** Empty draft, slash-command mode, oversized draft, no model configured, model error or timeout all surface as a readable line under the composer — the button never fails silently.
- **Localized** (English / 简体中文) and follows the Harness locale automatically.
- **Zero-config.** It uses the model already selected for the conversation (provider, model and credentials) — no API key of its own, no extra dependency, no build step.

## Install

### With an agent (recommended)

Ask your DSH agent to install the bundle, or point the harness plugin manager at this package:

```text
plugin_manager action=install_bundle target=dsh-prompt-optimizer
```

When DSH reports that the application needs a restart, restart DSH. The bundle mounts both halves — the Host route and the composer button.

### Manually

1. Add the package to your profile (from npm, from a git URL, or a local checkout):

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm add dsh-prompt-optimizer            # or: pnpm add link:/path/to/dsh-prompt-optimizer
   ```

2. Append it to `dsh.profile.bundles` in that directory's `package.json`:

   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-prompt-optimizer" ] } }
   ```

3. Restart DSH. The button appears left of Send in any conversation with an empty or non-empty draft.

### Verify the Host half

The plugin registers one route. With DSH running:

```bash
curl http://127.0.0.1:<port>/dsh-prompt-optimizer/health
# {"ok":true,"version":"1.0.0","route":"/dsh-prompt-optimizer","llm":true,"model":"deepseek-account/deepseek-flash","maxChars":12000}
```

## Configuration

Everything is optional; the shipped `cordis.patch.yml` row carries an empty `config`, and every knob has a working default.

| key | default | meaning |
| --- | --- | --- |
| `maxChars` | `12000` | Longest draft accepted, in characters (clamped to 200–40000). |
| `timeoutMs` | `90000` | Model-call budget in milliseconds (clamped to 5000–300000). |
| `temperature` | `0.6` | Sampling temperature for the rewrite (0–2). |
| `reasoning` | `"off"` | `"off"` asks for no extended thinking (faster, cheaper); `"keep"` uses the model default. `"off"` is only sent when the model declares that level. |
| `provider` | session model | Override the provider instead of following the conversation. |
| `model` | session model | Override the model instead of following the conversation. |

Example (`cordis.patch.yml`):

```yaml
- id: dsh-prompt-optimizer
  name: dsh-prompt-optimizer
  config:
    maxChars: 8000
    temperature: 0.4
```

## How it works

```text
Client half (client.js)                    Host half (index.js)
┌────────────────────────────┐             ┌──────────────────────────────┐
│ conversation.input.right   │  POST       │ /dsh-prompt-optimizer/optimize│
│  ✨ button                 │ ─────────►  │  · the only model call        │
│ reads/writes the draft via │  {text}     │  · ctx.llm + session model    │
│ conversation.input.for()   │ ◄─────────  │  · strips fences/labels       │
│ conversation.composer.dock │  {text}     │  · 90s abort, 2 in flight     │
└────────────────────────────┘             └──────────────────────────────┘
```

- The **Host half** owns the model call because the browser has no credentials and no provider access. It reads the conversation's current model selection (`ctx.agentDefaultModel`), streams one completion through `ctx.llm` with a prompt-engineer system prompt, cleans the output (code fences, `优化后的提示词：` labels) and answers JSON. It enforces a 256 KiB body limit, a `maxChars` draft limit and at most two concurrent rewrites; a client disconnect or a timeout aborts the model stream.
- The **Client half** registers into two Harness slot surfaces — `conversation.input.right` for the button and `conversation.composer.dock` for the notice strip — and reads and writes the draft through the conversation service rather than through DOM. It guards every write with the draft revision it observed, so a concurrently edited draft is never overwritten silently. Styling uses only `--dsw-alias-*` theme tokens and is installed into a single `<style>` element, so it follows light/dark and skins and does not leak on reload.

## Privacy

- The draft is sent to **your own** model provider, using **your own** account — exactly the provider and credentials the conversation already uses. There is no third-party service, no telemetry, no analytics.
- Nothing is written to the conversation transcript. Undo restores the original draft.
- The HTTP route is same-origin only, accepts relative URLs, does not cache, and returns errors as JSON.

## Requirements

- DSH with the Web UI (the slot API is a Web-UI contract). Built and tested against the DSH desktop 0.2.x Web UI.
- A conversation that already has a model selected (any provider with credentials).

## Troubleshooting

| symptom | fix |
| --- | --- |
| No sparkle button next to Send | DSH needs a restart after installing the bundle; confirm `dsh-prompt-optimizer` is in `dsh.profile.bundles`, then restart. |
| "Could not reach this conversation's composer" | The slot rendered outside a conversation scope — reload the page; open a conversation and retry. |
| "Optimization failed: … no model configured" | Pick a model in the conversation (or set `provider`/`model` in the config). |
| Always "another optimization is still running" | Two rewrites are already in flight somewhere in this DSH instance; wait for them. |
| Button does nothing on a huge draft | Drafts over `maxChars` are refused with a notice — trim it or raise `maxChars`. |
| `… failed to import: Cannot find package '@deepseek-ai/dsh-llm'` in the host log | The loader only maps `@deepseek-ai/*` to the running installation when the plugin declares it under `peerDependencies`. Keep that row in `package.json` (this package ships it). |
| `/health` answers but `llmRuntime` is `false` | The plugin mounts, but the LLM helpers are unreachable — the DSH build predates `@deepseek-ai/dsh-llm` or the peer row was removed. |

## Development

Plain ESM, no build step, no runtime dependency beyond the harness itself:

```text
index.js          Host half: config, the /dsh-prompt-optimizer route, the model call
client.js         Client half: composer button, notice dock, locale + styles
cordis.patch.yml  Bundle patch: the one loader row that mounts the Host half
locale/*.json     Plugin-list metadata (title, description) per locale
icon.svg          Original icon
test/             Offline harnesses for both halves (stub React, stub ctx, stub llm)
```

`node --check index.js client.js` is the whole lint. The test suites run without a DSH install — plain Node, a stub `@deepseek-ai/dsh-llm` wired in by a resolve hook:

```bash
node --import ./test/shim.mjs test/host.test.mjs   # 22 checks: routing, errors, model wiring
node test/client.test.mjs                          # 24 checks: slots, button, undo, stale drafts
```

Install the directory as a linked bundle (see above) and restart DSH to try a change.

## License

[MIT](./LICENSE)
