#!/usr/bin/env node
import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  closeSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'
import { readUiSession, writeUiSession } from './ui-session.js'
import {
  runUiSupervisor,
  validateUiSupervisorRequest,
  type UiSupervisorRequestV1,
} from './ui-supervisor.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory } from './ui-owned-directory.js'

export interface UiSupervisorBinDependencies {
  runSupervisor(request: UiSupervisorRequestV1): Promise<void>
  stderr(message: string): void
  now(): string
  beforeFailureWrite?(): void
  beforeRequestOpen?(path: string): void
  afterRequestRead?(path: string): void
}

export async function runSupervisorBin(
  argv: string[] = process.argv.slice(2),
  deps: UiSupervisorBinDependencies = defaultDependencies(),
): Promise<number> {
  let request: UiSupervisorRequestV1 | undefined
  let ownedSession: OwnedUiDirectory | undefined
  let safeToReport = false
  try {
    if (argv.length !== 1 || !argv[0] || argv[0].startsWith('-')) throw new Error('usage: ui-supervisor-bin <request-file>')
    const requestPath = resolve(argv[0])
    const parsed = JSON.parse(readRegular(requestPath, deps.beforeRequestOpen, deps.afterRequestRead)) as unknown
    validateUiSupervisorRequest(parsed)
    request = parsed
    const root = resolve(request.root)
    const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
    const sessionDir = join(runtimeRoot, 'ui-sessions', request.sessionId)
    assertContained(runtimeRoot, sessionDir, 'session directory')
    assertContained(sessionDir, requestPath, 'request file')
    if (requestPath !== join(sessionDir, 'request.json')) throw new Error('request file must be the session request.json')
    assertNoSymlinkComponents(runtimeRoot, 'forge runtime')
    assertNoSymlinkComponents(sessionDir, 'session directory')
    ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: sessionDir })
    ownedSession.assertCurrent()
    safeToReport = true
    await deps.runSupervisor(request)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (request !== undefined && safeToReport) {
      try { if (ownedSession !== undefined) reportFailure(request, ownedSession, message, deps.now(), deps.beforeFailureWrite) } catch { /* safe reporting is best effort */ }
    }
    deps.stderr(`ui supervisor: ${sanitize(message)}`)
    return 1
  }
}

function readRegular(path: string, beforeOpen?: (path: string) => void, afterRead?: (path: string) => void): string {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`request file is not a regular file: ${path}`)
  const parent = lstatSync(resolve(path, '..'))
  beforeOpen?.(path)
  const descriptor = openSync(path, constants.O_RDONLY | ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0))
  let contents: string
  try {
    const current = fstatSync(descriptor)
    if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino) throw new Error(`request file identity changed or was replaced: ${path}`)
    const currentParent = lstatSync(resolve(path, '..'))
    if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) throw new Error(`request parent identity changed: ${path}`)
    contents = readFileSync(descriptor, 'utf8')
  } finally { closeSync(descriptor) }
  afterRead?.(path)
  const afterParent = lstatSync(resolve(path, '..'))
  if (afterParent.dev !== parent.dev || afterParent.ino !== parent.ino) throw new Error(`request parent identity changed: ${path}`)
  const afterEntry = lstatSync(path)
  if (afterEntry.dev !== entry.dev || afterEntry.ino !== entry.ino) throw new Error(`request file identity changed after read: ${path}`)
  return contents
}

function defaultDependencies(): UiSupervisorBinDependencies {
  return {
    runSupervisor: request => runUiSupervisor(request),
    stderr: message => console.error(message),
    now: () => new Date().toISOString(),
  }
}

function reportFailure(request: UiSupervisorRequestV1, ownedSession: OwnedUiDirectory, message: string, now: string, beforeFailureWrite?: () => void): void {
  const root = resolve(request.root)
  const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
  ownedSession.assertCurrent()
  const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
  ownedSession.assertCurrent()
  if (state.state !== 'starting' && state.state !== 'ready' && state.state !== 'crashed') return
  if (state.cleanup === 'fail') return
  const { url: _url, cleanup: _cleanup, ...base } = state
  beforeFailureWrite?.()
  ownedSession.assertCurrent()
  try {
    writeUiSession({
      runtimeRoot,
      ownedSession,
      state: {
        ...base,
        state: 'crashed',
        error: sanitize(message),
        updatedAt: Date.parse(now) < Date.parse(state.updatedAt) ? state.updatedAt : now,
      },
    })
  } finally {
    ownedSession.assertCurrent()
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const outside = relative(resolve(root), resolve(candidate))
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error(`${label} escapes containing root`)
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolute = resolve(path)
  let current = resolve(absolute, sep)
  for (const component of relative(resolve(absolute, sep), absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    const entry = lstatSync(current)
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink at ${current}`)
  }
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || 'failure'
}

if (process.argv[1] && /ui-supervisor-bin\.(?:m?js|ts)$/i.test(process.argv[1])) {
  runSupervisorBin().then(code => { process.exitCode = code }).catch(error => {
    console.error(`ui supervisor: ${sanitize(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  })
}
