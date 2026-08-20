import { describe, it, expect } from 'vitest'
import { isAbsolute, join } from 'node:path'
import { resolveSourceOverlay, buildProfilePackageJson, buildSourceOverlay } from './run.js'

describe('resolveSourceOverlay', () => {
  it('produces an absolute path to the plugin entry', () => {
    const p = resolveSourceOverlay('workspace', 'plugins/example', 'src/index.ts', 'example')
    expect(isAbsolute(p)).toBe(true)
    expect(p.endsWith(join('plugins', 'example', 'src', 'index.ts'))).toBe(true)
  })
})

describe('buildProfilePackageJson', () => {
  it('pins the dsh bundle and an exact version', () => {
    const spec = { name: 'dsh-profile-next', bundles: ['@deepseek-ai/dsh-base'] }
    const out = buildProfilePackageJson(spec, { dsh: '0.1.0-rc.8' })
    expect(out.dependencies['@deepseek-ai/dsh']).toBe('0.1.0-rc.8')
    expect(out).toHaveProperty('dsh')
  })

  it('omits the launcher dependency when no pin is given (master composes against the built bin)', () => {
    const spec = { name: 'dsh-profile-master', bundles: ['@deepseek-ai/dsh-base'] }
    const out = buildProfilePackageJson(spec, {})
    expect(out.dependencies).toEqual({})
    expect(out.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })
})

describe('buildSourceOverlay', () => {
  it('escapes apostrophes by doubling them for the YAML single-quoted scalar', () => {
    const overlay = buildSourceOverlay('example', `A:/plugins/o'brien/src/index.ts`)
    expect(overlay).toContain(`name: 'A:/plugins/o''brien/src/index.ts'`)
    expect(overlay).not.toContain(`\\'`)
  })
})
