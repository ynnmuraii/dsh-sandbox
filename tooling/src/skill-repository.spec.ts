import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { loadCatalogFromFile, loadCompatibilityFromFile } from './schemas.js'

const AGENT_SKILL_PATH = '.agents/skills/dsh-plugin-development/SKILL.md'

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

  it('keeps the real skill advisory and free of repository-specific pins', () => {
    const root = process.cwd()
    const committed = readFileSync(join(root, AGENT_SKILL_PATH), 'utf8')
    const requiredReferences = [
      '../../../context/harness-contracts.md',
      '../../../context/cordis-model.md',
      '../../../context/plugin-anatomy.md',
      '../../../context/testing-policy.md',
      '../../../context/compatibility.md',
      '../../../context/lab-author-guide.md',
    ]

    for (const reference of requiredReferences) expect(committed).toContain(`](${reference})`)
    expect(committed).toMatch(/advisory workflows chosen by the agent and host harness/i)
    expect(committed).toMatch(/Plans, approvals, and session memory belong to the agent and host harness/i)
    expect(committed).not.toMatch(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)
    expect(committed).not.toMatch(/\b[0-9a-f]{40}\b/i)
    expect(committed).not.toMatch(/\b[A-Za-z]:[\\/]/)
  })

  it('keeps live catalog data, absolute host paths, and mandatory harness workflows out of guidance', () => {
    const root = process.cwd()
    const committed = readFileSync(join(root, AGENT_SKILL_PATH), 'utf8')
    const catalog = loadCatalogFromFile(join(root, 'catalog.yaml'))
    const compatibility = loadCompatibilityFromFile(join(root, 'workbench', 'compatibility.yaml'))

    for (const guidance of [committed]) {
      for (const [name, entry] of Object.entries(catalog.plugins)) {
        expect(guidance).not.toMatch(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i'))
        expect(guidance).not.toContain(entry.path)
        if (entry.repository !== undefined) expect(guidance).not.toContain(entry.repository)
      }
      expect(guidance).not.toContain(compatibility.targets.next.dsh)
      expect(guidance).not.toContain(compatibility.targets.master.commit)
      expect(guidance).not.toContain(compatibility.targets.master.repository)
      expect(guidance).not.toMatch(/(?:^|[\s("'`=])\/(?!\/)[^\s)"'`]+/m)
      expect(guidance).not.toMatch(/\b(?:must|required to|always)\s+(?:use|run|launch|delegate(?:\s+to)?)\s+(?:SDD|Codex|Claude|Pi|agent-browser|subagents?)\b/i)
      expect(guidance).not.toMatch(/\b(?:Codex|Claude|Pi|agent-browser|subagents?)\s+(?:must|required to|always)\b/i)
    }
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
