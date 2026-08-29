import { relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { File } from '@babel/types'
import { classNameFromPath, discoverControllerFiles } from './discovery'
import { extractClassDeclaration } from './model-parser'
import { parseSourceFile } from './parse-cache'
import { walk } from './ast-walk'

/**
 * Controller action bodies, extracted once and judged by regex afterwards.
 *
 * Lives here rather than in `audit.ts` because two commands ask the same
 * question of the same bodies: `guren audit` (validation, authentication,
 * force writes) and `guren check`'s agent-route rules (authorization
 * evidence, Inertia responses, delete calls). Importing `./audit` from a
 * core-suite check would drag the dependency and ignore-config machinery
 * into every `guren check` run for one map.
 *
 * The rule vocabularies stay where they are used: `CONTROLLER_MEMBER_KINDS`
 * and the audit's patterns remain in `audit.ts`, whose classification is
 * pinned against `Controller.ts` by `controller-surface.test.ts`.
 */
export interface ControllerMethodInfo {
  /** Method body source with comments and string contents blanked, offsets preserved. */
  body: string
  /** Controller file, relative to the project root. */
  filePath: string
}

/**
 * Two controller classes sharing one name. Reported rather than resolved:
 * routes carry `route.controller.name` alone, so nothing here can tell the
 * two apart — see {@link parseControllerMethods}.
 */
export interface ControllerNameCollision {
  className: string
  previousFile: string
  currentFile: string
}

export interface ControllerMethodScan {
  /** `ClassName.method` → body. Last file scanned wins on a collision. */
  methods: Map<string, ControllerMethodInfo>
  collisions: ControllerNameCollision[]
}

/**
 * Method bodies below are judged with regexes (VALIDATE_BODY_PATTERN,
 * AUTH_CALL_PATTERN, BODY_ACCESS_PATTERN, FORCE_WRITE_PATTERN), which cannot
 * tell live code from a commented-out line, a string that merely mentions an
 * API, JSX text, or a type-only declaration. A commented
 * `// await this.validateBody(...)` must not count as validation, a
 * `forceCreate` inside an error message must not warn, and neither must a
 * local `type Decoy = { validateBody(): void }` nested in the method body —
 * TS allows local type/interface declarations inside a function, and their
 * member signatures read exactly like the runtime call the regexes look for.
 * Blank comments, string/regex/JSX-text contents, template quasis, and whole
 * type-alias/interface declarations (never executable, so blanking the full
 * range is always safe) with spaces — offsets are preserved, so method-body
 * slices taken from the result line up with the original AST positions.
 * Template *expressions* are kept: they are live code.
 */
export function blankCommentsAndStrings(source: string, ast: File): string {
  const ranges: [number, number][] = []
  for (const comment of ast.comments ?? []) {
    if (typeof comment.start === 'number' && typeof comment.end === 'number') {
      ranges.push([comment.start, comment.end])
    }
  }
  walk(ast.program, (node) => {
    const { type, start, end } = node
    if (typeof start !== 'number' || typeof end !== 'number') return
    if (type === 'StringLiteral' || type === 'DirectiveLiteral') {
      ranges.push([start + 1, end - 1])
    } else if (type === 'TemplateElement' || type === 'RegExpLiteral' || type === 'JSXText') {
      ranges.push([start, end])
    } else if (type === 'TSTypeAliasDeclaration' || type === 'TSInterfaceDeclaration') {
      // Blank the whole declaration and stop descending — it contributes no
      // runtime code, so there is nothing further inside worth walking.
      ranges.push([start, end])
      return false
    }
  })
  if (ranges.length === 0) return source

  // split('') keeps UTF-16 code-unit indexing — Babel offsets are code units,
  // and a code-point spread would shift everything after an astral character.
  const chars = source.split('')
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' '
    }
  }
  return chars.join('')
}

/**
 * Map of `ClassName.method` → method body source, for every controller in
 * app/Http/Controllers (module-aware — see discoverControllerFiles).
 *
 * The map is keyed by class name alone, with no file/module namespacing —
 * routes only carry `route.controller.name` (the class's runtime `.name`),
 * not an import path, so route-level checks have no way to disambiguate two
 * same-named controllers in different modules. A flat
 * app/Http/Controllers/ directory can't produce this collision (the
 * filesystem itself enforces unique file names), but two modules each
 * scaffolding their own e.g. `PostController` legitimately can. When that
 * happens, verdicts for BOTH controllers' routes are drawn from whichever
 * file was discovered last — a validated action in one module can make an
 * unsafe, same-named one in another module read as "pass".
 *
 * Collisions are returned rather than resolved, and every caller must say
 * something about them: dropping them silently is fail-open, because the
 * body a rule just judged may belong to a different file than the route it
 * judged it for.
 */
export async function parseControllerMethods(cwd: string): Promise<ControllerMethodScan> {
  const methods = new Map<string, ControllerMethodInfo>()
  const collisions: ControllerNameCollision[] = []
  const classFiles = new Map<string, string>()
  const controllerFiles = await discoverControllerFiles(cwd)

  for (const filePath of controllerFiles) {
    const source = await readFile(filePath, 'utf-8')
    const relPath = relative(cwd, filePath)

    const ast = parseSourceFile(source, filePath)
    if (!ast) continue
    const scrubbed = blankCommentsAndStrings(source, ast)

    for (const node of ast.program.body) {
      const classDecl = extractClassDeclaration(node)
      if (!classDecl) continue
      const className = classDecl.id?.name ?? classNameFromPath(filePath)

      const previousFile = classFiles.get(className)
      if (previousFile && previousFile !== relPath) {
        collisions.push({ className, previousFile, currentFile: relPath })
      }
      classFiles.set(className, relPath)

      for (const member of classDecl.body.body) {
        if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
          const start = member.body.start ?? 0
          const end = member.body.end ?? 0
          methods.set(`${className}.${member.key.name}`, {
            body: scrubbed.slice(start, end),
            filePath: relPath,
          })
        }
      }
    }
  }

  return { methods, collisions }
}
