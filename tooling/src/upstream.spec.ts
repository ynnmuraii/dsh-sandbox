import { describe, it, expect } from 'vitest'
import { verifyUpstreamCommit } from './upstream.js'

describe('verifyUpstreamCommit', () => {
  it('false when the upstream dir is not a git checkout', async () => {
    const ok = await verifyUpstreamCommit(
      '/nonexistent',
      '0000000000000000000000000000000000000000',
    )
    expect(ok).toBe(false)
  })
})
