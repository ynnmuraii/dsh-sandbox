import { describe, it, expect } from 'vitest'
import { loadCompatibility, loadCatalog } from './schemas.js'

const fixture = `
targets:
  next:
    dsh: 0.1.0-rc.8
    cordis: 4.0.1
    node: 22.20.0
  master:
    repository: deepseek-ai/deepseek-harness
    commit: 0000000000000000000000000000000000000000
    pnpm: 11.7.0
`

describe('loadCompatibility', () => {
  it('parses both next and master targets', () => {
    const c = loadCompatibility(fixture)
    expect(c.targets.next.dsh).toBe('0.1.0-rc.8')
    expect(c.targets.master.commit).toHaveLength(40)
  })

  it('rejects a target with a caret range', () => {
    const bad = fixture.replace('0.1.0-rc.8', '^0.1.0-rc.8')
    expect(() => loadCompatibility(bad)).toThrow(/exact|pin/i)
  })

  it('rejects master without a 40-char commit', () => {
    const bad = fixture.replace(
      '0000000000000000000000000000000000000000',
      'short',
    )
    expect(() => loadCompatibility(bad)).toThrow(/commit/i)
  })
})

describe('loadCatalog', () => {
  it('parses a mixed tracking catalog', () => {
    const catalog = loadCatalog(`
plugins:
  a:
    path: plugins/a
    repository: https://github.com/example/a
    tracking: submodule
  b:
    path: plugins/b
    tracking: local
`)
    const a = catalog.plugins.a
    const b = catalog.plugins.b
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.tracking).toBe('submodule')
    expect(b!.tracking).toBe('local')
  })
})
