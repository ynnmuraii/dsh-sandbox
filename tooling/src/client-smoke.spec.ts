import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { clientBundleRequirement, verifyClientBundleInTarball, type ClientBundleRequirement } from './client-smoke.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-smoke-'))
  roots.push(root)
  return root
}

// Hand-rolled ustar + gzip helper — duplicated in package-verify.spec.ts by design.
function buildTarGz(entries: Array<{ name: string; content: Buffer | string }>): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content
    const header = createUstarHeader(entry.name, content.length)
    parts.push(header)
    parts.push(content)
    const pad = (512 - (content.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function createUstarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(Buffer.byteLength(name), 100))
  header.write('000644\x00', 100, 'utf8')
  header.write('0000000\x00', 108, 'utf8')
  header.write('0000000\x00', 116, 'utf8')
  const sizeOct = size.toString(8).padStart(11, '0') + '\0'
  header.write(sizeOct, 124, 'utf8')
  header.write('00000000000\x00', 136, 'utf8')
  header.write('        ', 148, 'utf8')
  header[156] = 0x30
  header.write('ustar\x00', 257, 'utf8')
  header.write('00', 263, 'utf8')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  const checksum = sum.toString(8).padStart(6, '0') + '\0 '
  header.write(checksum, 148, 'utf8')
  return header
}

function writeTarball(entries: Array<{ name: string; content: string }>): string {
  const dir = tmpDir()
  const tarball = join(dir, 'bundle.tgz')
  writeFileSync(tarball, buildTarGz(entries))
  return tarball
}

describe('clientBundleRequirement', () => {
  it('returns not required when dsh.client is absent', () => {
    const requirement = clientBundleRequirement({ name: '@fixture/demo' })
    expect(requirement).toEqual({ required: false, packageName: '@fixture/demo', entryPath: '' })
  })

  it('throws when dsh.client platform is non-web', () => {
    expect(() =>
      clientBundleRequirement({
        name: '@fixture/demo',
        dsh: { client: { platform: 'native' } },
        exports: { './client': './lib/client.js' },
      }),
    ).toThrow(/platform must be 'web'/)
  })

  it('throws when dsh.client declared but exports has no ./client', () => {
    expect(() =>
      clientBundleRequirement({
        name: '@fixture/demo',
        dsh: { client: { platform: 'web' } },
        exports: { './other': './lib/other.js' },
      }),
    ).toThrow(/exports no ".\/client"/)
  })

  it('resolves string export spelling', () => {
    const requirement = clientBundleRequirement({
      name: '@fixture/demo',
      dsh: { client: { platform: 'web' } },
      exports: { './client': './lib/client.js' },
    })
    expect(requirement).toEqual({ required: true, packageName: '@fixture/demo', entryPath: 'lib/client.js' })
  })

  it('resolves conditional-object export spelling with default', () => {
    const requirement = clientBundleRequirement({
      name: '@fixture/demo',
      dsh: { client: { platform: 'web' } },
      exports: { './client': { default: './lib/client.js' } },
    })
    expect(requirement).toEqual({ required: true, packageName: '@fixture/demo', entryPath: 'lib/client.js' })
  })

  it('normalizes ./ prefix and leading slash via normalizePackagePath', () => {
    const requirement = clientBundleRequirement({
      name: '@fixture/demo',
      dsh: { client: { platform: 'web' } },
      exports: { './client': '/lib/client.js' },
    })
    expect(requirement.entryPath).toBe('lib/client.js')
  })
})

describe('verifyClientBundleInTarball', () => {
  const baseRequirement: ClientBundleRequirement = {
    required: true,
    packageName: '@fixture/demo',
    entryPath: 'lib/client.js',
  }

  it('passes when the declared entry is present', () => {
    const tarball = writeTarball([
      { name: 'package/lib/client.js', content: "window.__ModuleLoader__.load({id:'@fixture/demo',factory:()=>({})})" },
    ])
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).not.toThrow()
  })

  it('throws when the entry is missing', () => {
    const tarball = writeTarball([{ name: 'package/lib/other.js', content: 'other' }])
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).toThrow(/does not contain the declared client bundle/)
  })

  it('throws on non-gzip input', () => {
    const dir = tmpDir()
    const tarball = join(dir, 'bundle.tgz')
    writeFileSync(tarball, Buffer.from('not gzip'))
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).toThrow(/not valid gzip/)
  })

  it('throws when bundle does not register', () => {
    const tarball = writeTarball([{ name: 'package/lib/client.js', content: 'console.log("no register")' }])
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).toThrow(/loaded without registering/)
  })

  it('throws on wrong id', () => {
    const tarball = writeTarball([
      { name: 'package/lib/client.js', content: "window.__ModuleLoader__.load({id:'wrong',factory:()=>({})})" },
    ])
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).toThrow(/registered id/)
  })

  it('throws on non-callable factory', () => {
    const tarball = writeTarball([
      { name: 'package/lib/client.js', content: "window.__ModuleLoader__.load({id:'@fixture/demo',factory:'nope'})" },
    ])
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).toThrow(/callable factory/)
  })

  it('throws on multiple registrations', () => {
    const tarball = writeTarball([
      {
        name: 'package/lib/client.js',
        content:
          "window.__ModuleLoader__.load({id:'@fixture/demo',factory:()=>({})}); window.__ModuleLoader__.load({id:'@fixture/demo',factory:()=>({})})",
      },
    ])
    expect(() => verifyClientBundleInTarball(tarball, baseRequirement)).toThrow(/registered 2 rows/)
  })

  it('throws when invoked without a requirement', () => {
    const tarball = writeTarball([{ name: 'package/lib/client.js', content: '' }])
    expect(() =>
      verifyClientBundleInTarball(tarball, { required: false, packageName: '', entryPath: '' }),
    ).toThrow(/invoked without a client-bundle requirement/)
  })

  it('accepts registration via self and __ModuleLoader__ aliases', () => {
    const tarballSelf = writeTarball([
      { name: 'package/lib/client.js', content: "self.__ModuleLoader__.load({id:'@fixture/demo',factory:()=>({})})" },
    ])
    expect(() => verifyClientBundleInTarball(tarballSelf, baseRequirement)).not.toThrow()
    const tarballDirect = writeTarball([
      { name: 'package/lib/client.js', content: "__ModuleLoader__.load({id:'@fixture/demo',factory:()=>({})})" },
    ])
    expect(() => verifyClientBundleInTarball(tarballDirect, baseRequirement)).not.toThrow()
  })
})
