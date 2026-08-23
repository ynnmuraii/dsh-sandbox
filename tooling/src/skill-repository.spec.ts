import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  AGENT_SKILL_PATH,
  SKILL_SOURCE_PATH,
  normalizeGeneratedText,
  renderAgentSkill,
} from './skill.js'
import { contextDocuments } from './sync.js'

function nestedSkillFiles(root: string): string[] {
  const pluginsRoot = join(root, 'plugins')
  if (!existsSync(pluginsRoot)) return []

  const found: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ['.git', 'node_modules'].includes(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === 'SKILL.md') {
        found.push(relative(root, path).replaceAll('\\', '/'))
      }
    }
  }
  visit(pluginsRoot)
  return found.sort()
}

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

  it('keeps the real skill concise, advisory, and free of repository-specific pins', () => {
    const root = process.cwd()
    const canonical = readFileSync(join(root, SKILL_SOURCE_PATH), 'utf8')
    const committed = readFileSync(join(root, AGENT_SKILL_PATH), 'utf8')
    const requiredReferences = [
      '../../../context/harness-contracts.md',
      '../../../context/cordis-model.md',
      '../../../context/plugin-anatomy.md',
      '../../../context/testing-policy.md',
      '../../../context/compatibility.md',
      '../../../docs/using-the-lab.md',
    ]

    for (const reference of requiredReferences) expect(committed).toContain(`](${reference})`)
    expect(committed).toMatch(/advisory workflows chosen by the agent and host harness/i)
    expect(committed).toMatch(/Plans, approvals, and session memory belong to the agent and host harness/i)
    expect(committed.trim().split(/\s+/).length).toBeLessThanOrEqual(600)
    expect(canonical).not.toMatch(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)
    expect(canonical).not.toMatch(/\b[0-9a-f]{40}\b/i)
    expect(canonical).not.toMatch(/\b[A-Za-z]:[\\/]/)
  })

  it('tracks exactly the approved root projection and finds no skill in a plugin repo', () => {
    const root = process.cwd()
    const tracked = execFileSync('git', ['ls-files', '--', '*SKILL.md'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .sort()

    expect(tracked).toEqual([AGENT_SKILL_PATH])
    expect(nestedSkillFiles(root)).toEqual([])
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
