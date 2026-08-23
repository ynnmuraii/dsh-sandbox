#!/usr/bin/env node
import {
  lstatSync,
  readFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'
import { readUiSession, writeUiSession } from './ui-session.js'
import {
  runUiSupervisor,
  validateUiSupervisorRequest,
  type UiSupervisorRequestV1,
} from './ui-supervisor.js'

export async function runSupervisorBin(argv: string[] = process.argv.slice(2)): Promise<number> {
  let request: UiSupervisorRequestV1 | undefined
  let safeToReport = false
  try {
    if (argv.length !== 1 || !argv[0] || argv[0].startsWith('-')) throw new Error('usage: ui-supervisor-bin <request-file>')
    const requestPath = resolve(argv[0])
    const parsed = JSON.parse(readRegular(requestPath)) as unknown
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
    safeToReport = true
    await runUiSupervisor(request)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (request !== undefined && safeToReport) {
      try { reportFailure(request, message) } catch { /* safe reporting is best effort */ }
    }
    console.error(`ui supervisor: ${sanitize(message)}`)
    return 1
  }
}

function readRegular(path: string): string {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`request file is not a regular file: ${path}`)
  return readFileSync(path, 'utf8')
}

function reportFailure(request: UiSupervisorRequestV1, message: string): void {
  const root = resolve(request.root)
  const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
  const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
  if (state.state !== 'starting' && state.state !== 'ready' && state.state !== 'crashed') return
  if (state.cleanup === 'fail') return
  const { url: _url, cleanup: _cleanup, ...base } = state
  const updatedAt = new Date().toISOString()
  writeUiSession({
    runtimeRoot,
    state: {
      ...base,
      state: 'crashed',
      error: sanitize(message),
      updatedAt: Date.parse(updatedAt) < Date.parse(state.updatedAt) ? state.updatedAt : updatedAt,
    },
  })
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
