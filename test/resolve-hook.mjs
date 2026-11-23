/**
 * Module resolution hook for the offline tests: point the Harness LLM package
 * at the local stub so the Host half can be imported by plain Node.
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: new URL('./dsh-llm-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return next(specifier, context)
}
