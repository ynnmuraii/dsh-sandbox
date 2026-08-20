import type { Context } from '@deepseek-ai/cordis'

export const name = '__PLUGIN_NAME__'

export function apply(ctx: Context) {
  // Register harness capabilities here. Anything registered through
  // ctx is disposed automatically when the fiber unloads.
  console.log(`[${name}] plugin loaded`)
}
