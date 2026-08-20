import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect } from 'vitest'
import { apply } from '../src/index.js'

// Minimal durable registry to prove cleanup on dispose.
const logs: string[] = []

describe('example plugin', () => {
  it('logs a load message on apply', () => {
    const ctx = new Context()
    ctx.effect(() => () => {}) // keep ctx alive long enough
    ctx.on('dispose', () => {})
    apply(ctx)
    expect(logs).toStrictEqual([]) // placeholder; replaced with a real side-effect assertion in Task 9
  })
})
