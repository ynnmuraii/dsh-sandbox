import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AGENT_SKILL_PATH,
  SKILL_SOURCE_PATH,
  normalizeGeneratedText,
  renderAgentSkill,
} from './skill.js'
import { contextDocuments } from './sync.js'

describe('committed portable agent skill projection', () => {
  it('matches the canonical context renderer', () => {
    const root = process.cwd()
    const body = readFileSync(join(root, SKILL_SOURCE_PATH), 'utf8')
    const committed = readFileSync(join(root, AGENT_SKILL_PATH), 'utf8')
    const expected = renderAgentSkill({ body, documents: contextDocuments(root) })

    expect(normalizeGeneratedText(committed)).toBe(expected)
  })

  it('keeps every routed local Markdown reference resolvable', () => {
    const root = process.cwd()
    const committed = readFileSync(join(root, AGENT_SKILL_PATH), 'utf8')
    const skillDir = dirname(join(root, AGENT_SKILL_PATH))
    const localLinks = [...committed.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)]
      .map(match => match[1]!)

    expect(localLinks.length).toBeGreaterThanOrEqual(6)
    for (const link of localLinks) {
      expect(existsSync(join(skillDir, link)), `missing routed reference: ${link}`).toBe(true)
    }
  })

  it('creates no host-specific or plugin-local skill mirror', () => {
    const root = process.cwd()
    for (const forbidden of [
      '.dsh/skills/dsh-plugin-development/SKILL.md',
      '.codex/skills/dsh-plugin-development/SKILL.md',
      'skills/dsh-plugin-development/SKILL.md',
      'plugins/example/.agents/skills/dsh-plugin-development/SKILL.md',
    ]) {
      expect(existsSync(join(root, forbidden)), `forbidden skill mirror: ${forbidden}`).toBe(false)
    }
  })
})
