#!/usr/bin/env bun
// Claude Code PostToolUse hook: lint the file just edited and feed oxlint's
// findings back to the agent (exit 2 + stderr), so a comment or promise
// mistake is fixed in the same turn rather than by CI. Exit 0 = nothing to say.
import { relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
let filePath: string | undefined
try {
  filePath = (JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: string } }).tool_input?.file_path
} catch {
  process.exit(0)
}
if (!filePath) process.exit(0)
const rel = relative(repoRoot, filePath)
if (rel.startsWith('..') || !/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) process.exit(0)

const result = Bun.spawnSync([resolve(repoRoot, 'node_modules/.bin/oxlint'), '--deny-warnings', '--disable-nested-config', '--format', 'unix', rel], { cwd: repoRoot })
const findings = result.stdout.toString().trim()
if (result.success || findings === '') process.exit(0)
console.error(`oxlint found issues in ${rel}:\n${findings}\nRules: .oxlintrc.json; comment rules are explained in .claude/rules/coding-standards.md (Comments).`)
process.exit(2)
