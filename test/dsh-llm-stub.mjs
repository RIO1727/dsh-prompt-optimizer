/**
 * Stand-in for `@deepseek-ai/dsh-llm`, wired in by `resolve-hook.mjs`.
 *
 * The real package only exists inside a DSH installation, so the offline tests
 * map the bare import onto this minimal shape: exactly the two symbols the
 * Host half uses and the assembler methods it calls.
 */
export class BlockAssembler {
  constructor() {
    this.text = ''
    this.finish = { kind: 'stop' }
  }

  push(chunk) {
    if (chunk && chunk.type === 'text') this.text += chunk.text
  }

  blocks() {
    return this.text === '' ? [] : [{ type: 'text', text: this.text }]
  }
}

export function createUserMessage(input) {
  return { role: 'user', ...input }
}
