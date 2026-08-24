import { createHash } from 'node:crypto'

export function normalizeGeneratedText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

export function contextDigest(reads: readonly string[]): string {
  const hash = createHash('sha256')
  for (const read of reads) {
    const bytes = Buffer.from(normalizeGeneratedText(read), 'utf8')
    hash.update(String(bytes.byteLength))
    hash.update('\0')
    hash.update(bytes)
  }
  return hash.digest('hex').slice(0, 12)
}
