import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CliError } from '../src/cli-error'
import type { BoardOp } from '../src/board/ops'
import { applyBoardOpsFile, BOARD_LOCK_DIR, boardPath, createBoard, listBoards, readBoard, readBoardOutline } from '../src/board/store'
import { createTempRoot } from './helpers'

const OPS: BoardOp[] = [
  { op: 'add', id: 'aa', kind: 'event', text: 'A' },
  { op: 'add', id: 'bb', kind: 'reaction', text: 'B', after: 'aa' },
  { op: 'connect', from: 'aa', to: 'bb' },
]

let root: string
let count = 0

/** A fresh application root with one empty board, so no test reads another's lock or file. */
async function app(slug = 'demo'): Promise<string> {
  count += 1
  const dir = join(root, `app-${count}`)
  await createBoard(dir, { slug, title: 'Demo', locale: 'en' })
  return dir
}

function lockPath(dir: string, slug = 'demo'): string {
  return join(dir, BOARD_LOCK_DIR, `${slug}.lock`)
}

/** The id of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, '--version'], { stdout: 'ignore', stderr: 'ignore' })
  await child.exited
  return child.pid
}

beforeAll(async () => {
  root = await createTempRoot('guren-board-store-')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createBoard', () => {
  test('should write an empty board in canonical form', async () => {
    const dir = await app()

    expect(await readFile(boardPath(dir, 'demo'), 'utf8')).toBe(
      `${JSON.stringify({ boardVersion: 1, title: 'Demo', locale: 'en', notes: [], arrows: [], sections: [] }, null, 2)}\n`,
    )
  })

  test('should refuse a slug that already has a board', async () => {
    const dir = await app()

    await expect(createBoard(dir, { slug: 'demo', title: 'Again', locale: 'en' })).rejects.toThrow('docs/boards/demo.board.json exists')
    expect((await readBoard(dir, 'demo')).title).toBe('Demo')
  })

  test('should refuse a slug that is not one before touching the disk', async () => {
    await expect(createBoard(root, { slug: '../escape', title: 'X', locale: 'en' })).rejects.toThrow(CliError)
    expect(existsSync(join(root, 'docs'))).toBe(false)
  })
})

describe('readBoard', () => {
  test('should name the command that creates a board when there is none', async () => {
    await expect(readBoard(root, 'nothing-here')).rejects.toThrow('guren board:new')
  })

  test('should refuse a file that is not a board, with the schema issues', async () => {
    const dir = await app()
    await writeFile(boardPath(dir, 'demo'), JSON.stringify({ boardVersion: 1, title: 'Demo', locale: 'en', notes: [{ id: 'aa' }], arrows: [], sections: [] }))

    await expect(readBoard(dir, 'demo')).rejects.toThrow('does not match the board schema')
  })
})

describe('applyBoardOpsFile', () => {
  test('should write the board and release the lock', async () => {
    const dir = await app()

    const result = await applyBoardOpsFile(dir, 'demo', OPS)

    expect(result).toMatchObject({ file: 'docs/boards/demo.board.json', changed: true, applied: 3, dropped: [] })
    expect((await readBoard(dir, 'demo')).arrows).toEqual([{ from: 'aa', to: 'bb' }])
    expect(existsSync(lockPath(dir))).toBe(false)
    expect(await readFile(join(dir, BOARD_LOCK_DIR, '.gitignore'), 'utf8')).toBe('*\n')
  })

  test('should leave the file\'s bytes alone when the same list is applied again', async () => {
    const dir = await app()
    await applyBoardOpsFile(dir, 'demo', OPS)
    const before = await readFile(boardPath(dir, 'demo'), 'utf8')

    const again = await applyBoardOpsFile(dir, 'demo', OPS)

    expect(again.changed).toBe(false)
    expect(again.dropped.map((drop) => drop.reason)).toEqual(['a note named aa exists', 'a note named bb exists'])
    expect(await readFile(boardPath(dir, 'demo'), 'utf8')).toBe(before)
  })

  test('should clear a lock whose process has exited', async () => {
    const dir = await app()
    await mkdir(join(dir, BOARD_LOCK_DIR), { recursive: true })
    await writeFile(lockPath(dir), `${await deadPid()}\n`)

    const result = await applyBoardOpsFile(dir, 'demo', OPS, { lockWaitMs: 200 })

    expect(result.applied).toBe(3)
    expect(existsSync(lockPath(dir))).toBe(false)
  })

  test('should report a lock a live process holds, without breaking it or writing', async () => {
    const dir = await app()
    await mkdir(join(dir, BOARD_LOCK_DIR), { recursive: true })
    await writeFile(lockPath(dir), `${process.pid}\n`)
    const before = await readFile(boardPath(dir, 'demo'), 'utf8')

    await expect(applyBoardOpsFile(dir, 'demo', OPS, { lockWaitMs: 100 })).rejects.toThrow(`is being written by process ${process.pid}`)

    expect(await readFile(lockPath(dir), 'utf8')).toBe(`${process.pid}\n`)
    expect(await readFile(boardPath(dir, 'demo'), 'utf8')).toBe(before)
  })

  test('should clear an empty lock once it is old, and wait on a fresh one', async () => {
    const dir = await app()
    await mkdir(join(dir, BOARD_LOCK_DIR), { recursive: true })
    await writeFile(lockPath(dir), '')

    await expect(applyBoardOpsFile(dir, 'demo', OPS, { lockWaitMs: 100 })).rejects.toThrow('delete .guren/boards/demo.lock')

    const minuteAgo = new Date(Date.now() - 60_000)
    await utimes(lockPath(dir), minuteAgo, minuteAgo)
    const result = await applyBoardOpsFile(dir, 'demo', OPS, { lockWaitMs: 100 })

    expect(result.applied).toBe(3)
    expect(existsSync(lockPath(dir))).toBe(false)
  })

  test('should leave no lock directory behind when there is no such board', async () => {
    const dir = join(root, 'empty-app')

    await expect(applyBoardOpsFile(dir, 'typo', OPS)).rejects.toThrow('No board at docs/boards/typo.board.json')
    expect(existsSync(join(dir, '.guren'))).toBe(false)
  })

  test('should not reformat a hand-edited board when the list changes nothing', async () => {
    const dir = await app()
    const byHand = JSON.stringify({ boardVersion: 1, title: 'Demo', locale: 'en', sections: [], arrows: [], notes: [] })
    await writeFile(boardPath(dir, 'demo'), byHand)

    const result = await applyBoardOpsFile(dir, 'demo', [{ op: 'remove', id: 'nobody' }])

    expect(result).toMatchObject({ changed: false, applied: 0 })
    expect(await readFile(boardPath(dir, 'demo'), 'utf8')).toBe(byHand)
  })

  test('should apply two lists sent at once, one after the other', async () => {
    const dir = await app()

    const [one, two] = await Promise.all([
      applyBoardOpsFile(dir, 'demo', [{ op: 'add', id: 'aa', kind: 'event', text: 'A' }]),
      applyBoardOpsFile(dir, 'demo', [{ op: 'add', id: 'bb', kind: 'event', text: 'B' }]),
    ])

    expect([one.applied, two.applied]).toEqual([1, 1])
    expect((await readBoard(dir, 'demo')).notes.map((note) => note.id)).toEqual(['aa', 'bb'])
  })
})

describe('listBoards', () => {
  test('should list each board with its counts, and say why a file is not one', async () => {
    const dir = await app('alpha')
    await applyBoardOpsFile(dir, 'alpha', [...OPS, { op: 'add', id: 'qq', kind: 'question', text: 'Why?', about: ['aa'] }])
    await writeFile(boardPath(dir, 'broken'), '{ not json')
    await writeFile(join(dir, 'docs/boards', 'Not A Slug.board.json'), '{}')
    await writeFile(join(dir, 'docs/boards', 'notes.md'), '# notes')

    const overview = await listBoards(dir)

    expect(overview.boards.map((board) => board.slug)).toEqual(['alpha', 'broken'])
    expect(overview.boards[0]).toEqual({
      slug: 'alpha',
      file: 'docs/boards/alpha.board.json',
      title: 'Demo',
      locale: 'en',
      notes: 3,
      questions: 1,
      arrows: 1,
      sections: 1,
    })
    expect(overview.boards[1]?.unreadable).toContain('is not valid JSON')
  })

  test('should be empty for an application with no boards directory', async () => {
    expect(await listBoards(join(root, 'no-such-app'))).toEqual({ schemaVersion: 1, boards: [] })
  })
})

describe('readBoardOutline', () => {
  test('should return the outline board:show prints', async () => {
    const dir = await app()
    await applyBoardOpsFile(dir, 'demo', OPS)

    const { file, outline } = await readBoardOutline(dir, 'demo')

    expect(file).toBe('docs/boards/demo.board.json')
    expect(outline).toContain('  [event aa] A  -> bb')
  })
})
