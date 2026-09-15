import { describe, expect, test } from 'bun:test'

import { ormRootImportLines } from './core-first-audit'

describe('ormRootImportLines', () => {
  test('should report every import shape naming the root specifier', () => {
    const source = [
      "import { defineModel } from '@guren/orm'",
      'import type { PlainObject } from "@guren/orm"',
      "export { Model } from '@guren/orm'",
      "import '@guren/orm'",
      "const orm = await import('@guren/orm')",
      ">  import { createSqliteDatabase } from '@guren/orm'",
    ].join('\n')

    expect(ormRootImportLines(source)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('should report a multi-line import on the line naming the specifier', () => {
    expect(ormRootImportLines("import {\n  defineModel,\n} from '@guren/orm'\n")).toEqual([3])
  })

  test('should allow the drizzle dialect barrels and other packages', () => {
    const source = [
      "import { sqliteTable, text } from '@guren/orm/drizzle/sqlite'",
      "import { sql } from '@guren/orm/drizzle/pg'",
      "import { defineModel } from '@guren/core'",
      "import { x } from '@guren/orm-extra'",
    ].join('\n')

    expect(ormRootImportLines(source)).toEqual([])
  })

  test('should ignore mentions of the package that are not imports', () => {
    const source = [
      "declare module '@guren/orm' {}",
      '"@guren/orm": "^2.10.1",',
      "disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime'],",
      'The `ModelNotFoundException` from `@guren/orm` renders as 404.',
    ].join('\n')

    expect(ormRootImportLines(source)).toEqual([])
  })
})
