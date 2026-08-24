import { describe, expect, it, vi } from 'vitest'
import {
  defaultProcessTreeDependencies,
  stopOwnedProcessTree,
  type OwnedProcessTreeHandle,
  type ProcessTreeDependencies,
} from './process-tree.js'

function ownedTree(pid = 4242, initiallyExited = false) {
  let leaderExited = initiallyExited
  let resolveExit!: () => void
  const exited = initiallyExited
    ? Promise.resolve()
    : new Promise<void>(resolve => { resolveExit = resolve })
  const handle: OwnedProcessTreeHandle = {
    pid,
    exited,
    leaderExited: () => leaderExited,
  }
  return {
    handle,
    exit() {
      if (leaderExited) return
      leaderExited = true
      resolveExit()
    },
  }
}

function dependencies(platform: 'windows' | 'posix'): ProcessTreeDependencies {
  return {
    platform,
    taskkill: vi.fn(async () => undefined),
    signalGroup: vi.fn(),
    waitForExit: vi.fn(async exited => {
      await exited
      return true
    }),
    treeAlive: vi.fn(() => false),
    termGraceMs: 5,
    killGraceMs: 5,
  }
}

describe('stopOwnedProcessTree', () => {
  it('treats only ESRCH as proof that an owned process identity is absent', () => {
    const deps = defaultProcessTreeDependencies()
    const probe = vi.spyOn(process, 'kill')
    const denied = Object.assign(new Error('access denied'), { code: 'EPERM' })
    probe.mockImplementationOnce(() => { throw denied })

    expect(() => deps.treeAlive(-4242)).toThrow(/access denied|EPERM/i)

    const absent = Object.assign(new Error('missing process'), { code: 'ESRCH' })
    probe.mockImplementationOnce(() => { throw absent })
    expect(deps.treeAlive(-4242)).toBe(false)

    probe.mockImplementationOnce(() => true)
    expect(deps.treeAlive(-4242)).toBe(true)
  })

  it('fails closed on Windows when the leader exited before tree termination began', async () => {
    const tree = ownedTree(4242, true)
    const deps = dependencies('windows')

    await expect(stopOwnedProcessTree(tree.handle, deps)).rejects.toThrow(
      /leader|ownership|tree|descendant|prove|cleanup/i,
    )

    expect(deps.taskkill).not.toHaveBeenCalled()
  })

  it('accepts Windows cleanup only after taskkill targets a demonstrably live owned leader', async () => {
    const tree = ownedTree()
    const deps = dependencies('windows')
    vi.mocked(deps.taskkill).mockImplementation(async () => { tree.exit() })

    await stopOwnedProcessTree(tree.handle, deps)

    expect(deps.taskkill).toHaveBeenCalledWith(['/PID', '4242', '/T', '/F'])
    expect(deps.waitForExit).toHaveBeenCalledWith(tree.handle.exited, 5)
  })

  it('continues to prove a POSIX process group absent after its leader exits', async () => {
    const tree = ownedTree(4242, true)
    const deps = dependencies('posix')
    vi.mocked(deps.treeAlive)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    await stopOwnedProcessTree(tree.handle, deps)

    expect(deps.signalGroup).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(deps.treeAlive).toHaveBeenCalledWith(-4242)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid owned PID %s before mutation', async pid => {
    const tree = ownedTree(pid)
    const deps = dependencies('windows')

    await expect(stopOwnedProcessTree(tree.handle, deps)).rejects.toThrow(/pid|positive|integer/i)
    expect(deps.taskkill).not.toHaveBeenCalled()
  })
})
