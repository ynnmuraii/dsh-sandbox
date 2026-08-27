#!/usr/bin/env node
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'
import { readDevSession, writeDevSession } from './dev-session-state.js'
import {
  runDevSupervisor,
  validateDevSupervisorRequest,
  type DevSupervisorRequestV1,
} from './dev-supervisor.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory, type UiDirectoryIdentity } from './ui-owned-directory.js'

export interface DevSupervisorBinDependencies {
  runSupervisor(request: DevSupervisorRequestV1): Promise<void>
  stderr(message: string): void
  now(): string
}

export async function runDevSupervisorBin(
  argv: string[] = process.argv.slice(2),
  deps: DevSupervisorBinDependencies = defaultDependencies(),
): Promise<number> {
  let request: DevSupervisorRequestV1 | undefined
  let ownedSession: OwnedUiDirectory | undefined
  let safeToReport = false
  try {
    if (argv.length !== 1 || !argv[0] || argv[0].startsWith('-')) throw new Error('usage: dev-supervisor-bin <request-file>')
    const requestPath = resolve(argv[0])
    const requestRead = readRegular(requestPath)
    const parsed = JSON.parse(requestRead.contents) as unknown
    validateDevSupervisorRequest(parsed)
    request = parsed
    const root = resolve(request.root)
    const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
    const sessionDir = join(runtimeRoot, 'dev-sessions', request.sessionId)
    assertContained(runtimeRoot, sessionDir, 'session directory')
    assertContained(sessionDir, requestPath, 'request file')
    if (requestPath !== join(sessionDir, 'request.json')) throw new Error('request file must be the session request.json')
    assertNoSymlinkComponents(runtimeRoot, 'forge runtime')
    assertNoSymlinkComponents(sessionDir, 'session directory')
    assertIdentity(resolve(requestPath, '..'), requestRead.parentIdentity, 'request parent identity changed')
    ownedSession = claimOwnedUiDirectory({
      root: runtimeRoot,
      directory: sessionDir,
      expectedIdentity: requestRead.parentIdentity,
    })
    ownedSession.assertCurrent()
    safeToReport = true
    await deps.runSupervisor(request)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (request !== undefined && safeToReport) {
      try { if (ownedSession !== undefined) reportFailure(request, ownedSession, message, deps.now()) } catch { /* safe reporting is best effort */ }
    }
    deps.stderr(`dev supervisor: ${sanitizeDiagnostic(message)}`)
    return 1
  }
}

interface FileIdentity extends UiDirectoryIdentity {
  dev: number
  ino: number
}

interface ReadRegularResult {
  contents: string
  parentIdentity: FileIdentity
}

function readRegular(path: string): ReadRegularResult {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`request file is not a regular file: ${path}`)
  const parent = lstatSync(resolve(path, '..'))
  const descriptor = openSync(path, constants.O_RDONLY | ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0))
  let contents: string
  try {
    const current = fstatSync(descriptor)
    if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino) throw new Error(`request file identity changed or was replaced: ${path}`)
    const currentParent = lstatSync(resolve(path, '..'))
    if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) throw new Error(`request parent identity changed: ${path}`)
    contents = readFileSync(descriptor, 'utf8')
  } finally { closeSync(descriptor) }
  const afterParent = lstatSync(resolve(path, '..'))
  if (afterParent.dev !== parent.dev || afterParent.ino !== parent.ino) throw new Error(`request parent identity changed: ${path}`)
  const afterEntry = lstatSync(path)
  if (afterEntry.dev !== entry.dev || afterEntry.ino !== entry.ino) throw new Error(`request file identity changed after read: ${path}`)
  return { contents, parentIdentity: { dev: parent.dev, ino: parent.ino } }
}

function assertIdentity(path: string, expected: FileIdentity, message: string): void {
  const actual = lstatSync(path)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`${message}: ${path}`)
}

function defaultDependencies(): DevSupervisorBinDependencies {
  return {
    runSupervisor: request => runDevSupervisor(request),
    stderr: message => console.error(message),
    now: () => new Date().toISOString(),
  }
}

function reportFailure(request: DevSupervisorRequestV1, ownedSession: OwnedUiDirectory, message: string, now: string): void {
  const root = resolve(request.root)
  const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
  ownedSession.assertCurrent()
  const state = readDevSession({ runtimeRoot, sessionId: request.sessionId })
  if (state.state === 'stopped') return
  const crashedBase = { ...state }
  delete crashedBase.url
  delete crashedBase.cleanup
  writeDevSession({
    runtimeRoot,
    state: {
      ...crashedBase,
      state: 'crashed',
      error: sanitizeDiagnostic(message),
      updatedAt: nextTimestamp(now, state.updatedAt),
    },
    ownedSession,
  })
}

function nextTimestamp(candidate: string, previous: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(candidate) || Number.isNaN(Date.parse(candidate))) return previous
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate
}

function sanitizeDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || 'failure'
}

function assertContained(root: string, candidate: string, label: string): void {
  const outside = relative(resolve(root), resolve(candidate))
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error(`${label} escapes containing root`)
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction at ${current}`)
  }
}

if (process.argv[1] && /dev-supervisor-bin\.(?:m?js|ts)$/i.test(process.argv[1])) {
  runDevSupervisorBin().then(code => { process.exitCode = code }).catch(error => {
    console.error(`dev supervisor: ${sanitizeDiagnostic(error instanceof Error ? error.message : String(error))}`)
    process.exitCode = 1
  })
}
