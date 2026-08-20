import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '__PLUGIN_NAME__'
export const inject = ['tools']

export function apply(ctx: Context) {
  // Register inside an effect so the tool is disposed (unregistered) when the
  // plugin's fiber unloads. The register disposer becomes the effect disposer.
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'greet',
        description: 'Greet a named person.',
        parameters: {
          name: { type: 'string', required: true, description: 'Who to greet' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value: string) => [{ type: 'text', text: value }],
        },
        async execute(args: { name: string }) {
          return `Hello, ${args.name}!`
        },
      }),
    ),
  )
}
