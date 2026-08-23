/**
 * Runtime plugin identities are used as directory-name components below the
 * forge-owned `.lab/runtime` boundary. Keep this check centralized so every
 * caller applies the same conservative contract before doing any work.
 */
const SAFE_RUNTIME_PLUGIN_IDENTITY = /^[a-z0-9][a-z0-9-]*$/

export function assertRuntimePluginIdentity(identity: string): string {
  if (!SAFE_RUNTIME_PLUGIN_IDENTITY.test(identity)) {
    throw new Error(`invalid runtime plugin identity ${JSON.stringify(identity)}`)
  }
  return identity
}
