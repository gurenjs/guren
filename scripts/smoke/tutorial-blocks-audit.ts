/**
 * `audit:tutorial-blocks`: every chapter under docs/<locale>/tutorials/ parses
 * under the RFC 0019 fence grammar, every locale has the same chapter files,
 * and each mirror's executable blocks are byte-identical to the English ones.
 * Code stays English in both locales (test names and UI strings inside `file=`
 * blocks included); only prose translates. Fast and hermetic: this is the gate
 * `smoke:tutorial` assumes has already passed.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  chapterFiles,
  compareExecutableSequences,
  parseTutorialBlocks,
  type BlockIssue,
  type ParsedChapter,
} from './tutorial-blocks'

const repoRoot = resolve(import.meta.dir, '../..')
export const REFERENCE_LOCALE = 'en'
export const MIRROR_LOCALES = ['ja'] as const

export function tutorialsDir(locale: string): string {
  return join(repoRoot, 'docs', locale, 'tutorials')
}

async function parseChapter(locale: string, name: string): Promise<ParsedChapter> {
  const file = join('docs', locale, 'tutorials', name)
  return parseTutorialBlocks(await readFile(join(repoRoot, file), 'utf8'), file)
}

export async function auditTutorialBlocks(): Promise<BlockIssue[]> {
  const issues: BlockIssue[] = []
  const referenceNames = await chapterFiles(tutorialsDir(REFERENCE_LOCALE))
  const reference = new Map<string, ParsedChapter>()
  for (const name of referenceNames) {
    const chapter = await parseChapter(REFERENCE_LOCALE, name)
    issues.push(...chapter.issues)
    reference.set(name, chapter)
  }

  for (const locale of MIRROR_LOCALES) {
    const names = await chapterFiles(tutorialsDir(locale))
    for (const name of referenceNames) {
      if (!names.includes(name)) {
        issues.push({ file: join('docs', locale, 'tutorials', name), line: 0, message: `missing: the ${REFERENCE_LOCALE} course has this chapter` })
      }
    }
    for (const name of names) {
      const chapter = await parseChapter(locale, name)
      issues.push(...chapter.issues)
      const ref = reference.get(name)
      if (!ref) {
        issues.push({ file: chapter.file, line: 0, message: `no ${REFERENCE_LOCALE} chapter of this name; the English course is the reference` })
        continue
      }
      if (chapter.issues.length === 0 && ref.issues.length === 0) {
        issues.push(...compareExecutableSequences(ref, chapter))
      }
    }
  }
  return issues
}

export function formatIssues(issues: readonly BlockIssue[]): string {
  return issues.map((issue) => `${issue.file}:${issue.line}: ${issue.message}`).join('\n')
}

if (import.meta.main) {
  const issues = await auditTutorialBlocks()
  if (issues.length > 0) {
    console.error('Tutorial block audit failed:\n' + formatIssues(issues))
    process.exit(1)
  }
  const chapters = await chapterFiles(tutorialsDir(REFERENCE_LOCALE))
  console.log(`Tutorial block audit passed: ${chapters.length} chapter(s), locales ${[REFERENCE_LOCALE, ...MIRROR_LOCALES].join(', ')}`)
}
