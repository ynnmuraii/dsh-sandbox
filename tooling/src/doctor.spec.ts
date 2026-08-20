import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from './doctor.js'

describe('doctor', () => {
  it('reports missing compatibility manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-'))
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /compatibility/i.test(r.message))).toBe(true)
  })

  it('reports version mismatch between manifest and installed node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-'))
    mkdirSync(join(dir, 'workbench'), { recursive: true })
    writeFileSync(
      join(dir, 'workbench', 'compatibility.yaml'),
      [
        'targets:',
        '  next:',
        '    dsh: 0.1.0-rc.8',
        '    cordis: 4.0.1',
        '    node: 1.0.0',
        '  master:',
        '    repository: deepseek-ai/deepseek-harness',
        '    commit: 0000000000000000000000000000000000000000',
        '    pnpm: 11.7.0',
      ].join('\n'),
    )
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /node/i.test(r.message))).toBe(true)
  })
})
