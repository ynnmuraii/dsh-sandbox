import { describe, it, expect } from 'vitest'
import { loadCompatibility, loadCatalog } from './schemas.js'

const fixture = `
targets:
  next:
    dsh: 0.1.0-rc.8
    cordis: 4.0.1
    node: 22.20.0
    pnpm: 11.7.0
  master:
    repository: deepseek-ai/deepseek-harness
    commit: 0000000000000000000000000000000000000000
    pnpm: 11.7.0
    node: ^22.19.0
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

  it('rejects an empty next target (every mandatory field required)', () => {
    const bad = `
targets:
  next: {}
  master:
    repository: deepseek-ai/deepseek-harness
    commit: 0000000000000000000000000000000000000000
    pnpm: 11.7.0
    node: ^22.19.0
`
    expect(() => loadCompatibility(bad)).toThrow(/next.*requires a mandatory pin field 'dsh'/)
  })

  it('rejects a master target missing pnpm', () => {
    const bad = fixture.replace('    pnpm: 11.7.0\n    node: ^22.19.0', '    node: ^22.19.0')
    expect(() => loadCompatibility(bad)).toThrow(/master.*requires a mandatory pin field 'pnpm'/)
  })

  it('rejects a next target missing pnpm', () => {
    const bad = fixture.replace('    node: 22.20.0\n    pnpm: 11.7.0', '    node: 22.20.0')
    expect(() => loadCompatibility(bad)).toThrow(/next.*requires a mandatory pin field 'pnpm'/)
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
