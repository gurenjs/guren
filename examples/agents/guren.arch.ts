import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  rules: [
    {
      from: 'app/Agents/**',
      disallow: ['app/Models/**', 'db/**'],
      disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime'],
      message:
        'Agents act through the tool surface, never through application internals (RFC 0017 §4). Widen what this agent may reach by adding scopes in config/agents.ts.',
    },
  ],
})
