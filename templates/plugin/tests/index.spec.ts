import { Context, Service } from '@deepseek-ai/cordis'
import { describe, it, expect } from 'vitest'
import * as Plugin from '../src/index.js'

/**
 * Real cordis Service registered under the name `tools`. It stands in for the
 * dsh-tools runtime but implements only the `register` surface the template
 * plugin calls, recording each tool name and returning a disposer that removes
 * it — mirroring `ToolRuntime.register`'s exact contract.
 */
class FakeTools extends Service {
  readonly registered: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(def: { name: string }): () => void {
    this.registered.push(def.name)
    return () => {
      const idx = this.registered.indexOf(def.name)
      if (idx >= 0) this.registered.splice(idx, 1)
    }
  }
}

describe('template plugin lifecycle', () => {
  it('registers the greet tool and unregisters it on fiber dispose', async () => {
    const ctx = new Context()
    const fake = new FakeTools(ctx)

    // Mount the plugin; it injects 'tools', which our fake provides.
    const fiber = ctx.plugin({ name: Plugin.name, inject: Plugin.inject, apply: Plugin.apply })
    await fiber

    expect(fake.registered).toContain('greet')

    // Unload the plugin fiber; the tool's effect disposer must run, removing it.
    await fiber.dispose()
    expect(fake.registered).not.toContain('greet')
  })
})
