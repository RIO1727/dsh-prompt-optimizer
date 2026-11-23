/**
 * Entry point for `node --import ./test/shim.mjs <test>`: installs the
 * `@deepseek-ai/dsh-llm` stub before any test module is loaded.
 */
import { register } from 'node:module'

register('./resolve-hook.mjs', import.meta.url)
