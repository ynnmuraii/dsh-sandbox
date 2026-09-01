import { describe, expect, it } from 'vitest'
import { sanitizeInheritedEnv } from './proc.js'

describe('sanitizeInheritedEnv', () => {
  it('drops credential-shaped variables from every supported shape', () => {
    const env = sanitizeInheritedEnv({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'sk-live',
      OPENAI_API_KEY: 'sk-openai',
      ANTHROPIC_API_KEY: 'sk-ant',
      GEMINI_API_KEY: 'gem',
      DEEPSEEK_TOKEN: 'tok',
      HF_TOKEN: 'hf',
      EXA_API_KEY: 'exa',
      ORCA_AGENT_HOOK_TOKEN: 'hook',
      CI_SECRET: 'sec',
      GITHUB_CREDENTIALS: 'cred',
      DB_PASSWORD: 'pw',
      AWS_ACCESS_KEY_ID: 'ak',
      PRIVATE_KEY: 'pk',
    })
    expect(env.PATH).toBe('/usr/bin')
    for (const key of [
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'DEEPSEEK_TOKEN',
      'HF_TOKEN',
      'EXA_API_KEY',
      'ORCA_AGENT_HOOK_TOKEN',
      'CI_SECRET',
      'GITHUB_CREDENTIALS',
      'DB_PASSWORD',
      'AWS_ACCESS_KEY_ID',
      'PRIVATE_KEY',
    ]) {
      expect(env).not.toHaveProperty(key)
    }
  })

  it('keeps the variables a lab child actually needs', () => {
    const env = sanitizeInheritedEnv({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      NODE_OPTIONS: '--import=tsx',
      DSH_HOME: 'A:/x/.lab/runtime',
      CI: 'true',
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      NODE_OPTIONS: '--import=tsx',
      DSH_HOME: 'A:/x/.lab/runtime',
      CI: 'true',
    })
  })

  it('matches case-insensitively because Windows env names are case-insensitive', () => {
    const env = sanitizeInheritedEnv({ deepseek_api_key: 'sk', Openai_Token: 'tok', path: '/bin' })
    expect(env.deepseek_api_key).toBeUndefined()
    expect(env.Openai_Token).toBeUndefined()
    expect(env.path).toBe('/bin')
  })

  it('does not mutate the source environment', () => {
    const source: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk', PATH: '/bin' }
    sanitizeInheritedEnv(source)
    expect(source.DEEPSEEK_API_KEY).toBe('sk')
  })
})
