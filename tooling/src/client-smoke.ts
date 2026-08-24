/**
 * Lab-owned acceptance gate for the browser face of a dual-face plugin.
 *
 * The upstream client module system serves the plugin's `./client` export as a
 * classic script at `/plugins/<id>/client.js` and expects it to register itself
 * synchronously through `window.__ModuleLoader__.load({ id, factory })`. A
 * bundle that ships the wrong module format (for example an un-wrapped ESM
 * output) fails only inside a real browser boot — the host-face pack-smoke
 * stays green. This module closes that gap at the packed-tarball boundary:
 * it extracts the client entry from the tarball `files` payload and executes
 * it in a fresh V8 context with a capturing module-loader facade.
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import vm from 'node:vm'

/** Whether the staged manifest demands a client bundle, and where it lives. */
export interface ClientBundleRequirement {
  required: boolean
  packageName: string
  /** Tarball-entry-relative path of the client bundle (for example `lib/client.js`), empty when not required. */
  entryPath: string
}

interface PackageJsonLike {
  name?: unknown
  dsh?: unknown
  exports?: unknown
}

/**
 * Derive the client-bundle requirement from a plugin package manifest.
 * Throws on a malformed `dsh.client` declaration — the same shape the upstream
 * composition rejects at boot, surfaced here before any browser round-trip.
 * @param manifest parsed package.json of the staged plugin workspace.
 */
export function clientBundleRequirement(manifest: unknown): ClientBundleRequirement {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('client-smoke: package.json must contain an object')
  }
  const pkg = manifest as PackageJsonLike
  const packageName = typeof pkg.name === 'string' ? pkg.name : ''
  const dsh = pkg.dsh
  const decl = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
    ? (dsh as Record<string, unknown>).client
    : undefined
  if (decl === undefined) return { required: false, packageName, entryPath: '' }
  if (typeof decl !== 'object' || decl === null || Array.isArray(decl)) {
    throw new Error('client-smoke: dsh.client declaration must be an object')
  }
  const fields = decl as Record<string, unknown>
  if (fields.platform !== 'web') {
    throw new Error(`client-smoke: dsh.client.platform must be 'web' (got ${JSON.stringify(fields.platform)})`)
  }
  for (const key of ['inject', 'external'] as const) {
    const value = fields[key]
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw new Error(`client-smoke: dsh.client.${key} must be a string array`)
    }
  }
  const clientRel = clientExportPath(pkg.exports)
  if (clientRel === undefined) {
    throw new Error('client-smoke: dsh.client declared but package.json exports no "./client" bundle')
  }
  return { required: true, packageName, entryPath: clientRel }
}

/**
 * Resolve the `./client` export to a package-relative path, accepting the
 * plain-string and conditional-object export spellings.
 */
function clientExportPath(exportsField: unknown): string | undefined {
  if (typeof exportsField === 'string') return undefined
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return undefined
  const entry = (exportsField as Record<string, unknown>)['./client']
  if (typeof entry === 'string') return normalizePackagePath(entry)
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    const target = (entry as Record<string, unknown>).default
    if (typeof target === 'string') return normalizePackagePath(target)
  }
  return undefined
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * Assert the packed tarball carries a registrable client bundle.
 * @param tarball absolute path of the `pnpm pack` tarball.
 * @param requirement the staged manifest's client-bundle requirement.
 * @throws when the bundle is missing from the tarball or fails to register.
 */
export function verifyClientBundleInTarball(tarball: string, requirement: ClientBundleRequirement): void {
  if (!requirement.required || requirement.entryPath === '') {
    throw new Error('client-smoke: invoked without a client-bundle requirement')
  }
  const source = extractTarEntry(readFileSync(tarball), requirement.entryPath)
  if (source === undefined) {
    throw new Error(
      `client-smoke: tarball ${tarball} does not contain the declared client bundle '${requirement.entryPath}' ` +
      '(check the package.json files list)',
    )
  }
  assertClientRegistration(source, requirement.packageName, requirement.entryPath)
}

/**
 * Read one regular-file entry out of a gzip-compressed tar archive.
 * Supports the ustar header layout (including the prefix field); pax/GNU
 * metadata records are skipped.
 * @param gzip the raw tarball bytes.
 * @param wanted package-relative entry path (the `package/` root is stripped).
 * @returns the entry contents, or undefined when absent.
 */
function extractTarEntry(gzip: Buffer, wanted: string): Buffer | undefined {
  let tar: Buffer
  try {
    tar = gunzipSync(gzip)
  } catch (error) {
    throw new Error(`client-smoke: tarball is not valid gzip data: ${error instanceof Error ? error.message : String(error)}`)
  }
  const wantedPath = normalizePackagePath(wanted)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    if (name === '' && header[156] === 0) break
    const prefix = header.subarray(345, 345 + 155).toString('utf8').replace(/\0.*$/s, '')
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const sizeField = header.subarray(124, 124 + 12).toString('utf8').replace(/\0.*$/s, '')
    const sizeText = sizeField.trim()
    let size: number | undefined
    if (sizeText === '') size = 0
    else if (!/^[0-7]+$/.test(sizeText)) size = undefined
    else size = Number.parseInt(sizeText, 8)
    if (size === undefined) {
      throw new Error(`client-smoke: malformed tar header size field for entry '${fullName}'`)
    }
    const type = header[156]
    offset += 512
    const padded = Math.ceil(size / 512) * 512
    const data = tar.subarray(offset, offset + size)
    offset += padded
    // Type flags: '0' or NUL = regular file. 'x'/'g' = pax metadata, 'L'/'K' =
    // GNU long-name/long-link (not produced by pnpm pack) — skipped.
    const regular = type === 0x30 || type === 0x00
    if (!regular) continue
    const normalizedFull = normalizePackagePath(fullName)
    if (normalizedFull === wantedPath || normalizedFull === `package/${wantedPath}`) return Buffer.from(data)
  }
  return undefined
}

/**
 * Execute the client bundle the way the browser's module table does and assert
 * the registration contract: exactly one synchronous
 * `window.__ModuleLoader__.load({ id, factory })` call whose id matches the
 * package name and whose factory is callable.
 */
function assertClientRegistration(source: Buffer, packageName: string, entryPath: string): void {
  const registrations: unknown[] = []
  const loader: Record<string, unknown> & { load: (registration: unknown) => void } = {
    load: (registration: unknown) => {
      registrations.push(registration)
    },
  };
  // The browser boot exposes the loader both as a global and under window/self.
  // Support the canonical `window.__ModuleLoader__.load` as well as the aliased
  // `self.__ModuleLoader__.load` and direct `__ModuleLoader__.load` that the
  // upstream module system tolerates. Window/self also expose `load` directly
  // for legacy bundles that register through `window.load`.
  (loader as Record<string, unknown>).__ModuleLoader__ = loader;
  const windowObj: Record<string, unknown> = { __ModuleLoader__: loader, load: loader.load }
  const selfObj: Record<string, unknown> = { __ModuleLoader__: loader, load: loader.load }
  const context = vm.createContext({ window: windowObj, self: selfObj, __ModuleLoader__: loader })
  try {
    vm.runInContext(source.toString('utf8'), context, { filename: entryPath })
  } catch (error) {
    throw new Error(
      `client-smoke: client bundle '${entryPath}' threw during registration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (registrations.length === 0) {
    throw new Error(
      `client-smoke: client bundle '${entryPath}' loaded without registering through window.__ModuleLoader__.load ` +
      '(the bundle must be a classic script registering a { id, factory } row)',
    )
  }
  if (registrations.length > 1) {
    throw new Error(`client-smoke: client bundle '${entryPath}' registered ${registrations.length} rows; expected exactly one`)
  }
  const registration = registrations[0]
  if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
    throw new Error(`client-smoke: client bundle '${entryPath}' registered a non-object row`)
  }
  const row = registration as Record<string, unknown>
  if (typeof row.factory !== 'function') {
    throw new Error(`client-smoke: client bundle '${entryPath}' registered without a callable factory`)
  }
  const id = row.id
  if (typeof id !== 'string' || (packageName !== '' && id !== packageName)) {
    throw new Error(
      `client-smoke: client bundle '${entryPath}' registered id ${JSON.stringify(id)}; expected the package name '${packageName}'`,
    )
  }
}
