import type { PlainObject } from '../Model'

export type DrizzleLikeSelect = {
  where?: (clause: unknown) => DrizzleLikeSelect
  orderBy?: (...clauses: unknown[]) => DrizzleLikeSelect
  limit?: (value: number) => DrizzleLikeSelect
  offset?: (value: number) => DrizzleLikeSelect
  groupBy?: (...columns: unknown[]) => DrizzleLikeSelect
  all?: () => Promise<unknown[]>
  get?: () => Promise<unknown>
}

type DrizzleSelectBuilder = DrizzleLikeSelect & { from(table: unknown): DrizzleLikeSelect }

type DrizzleLikeInsert = {
  values: (record: PlainObject) => DrizzleLikeInsertResult
}

export type DrizzleLikeInsertResult = {
  returning?: () => Promise<unknown[]>
  run?: () => Promise<unknown>
}

export type DrizzleLikeUpdate = {
  set: (record: PlainObject) => DrizzleLikeUpdate
  where: (clause: unknown) => DrizzleLikeUpdate
  returning?: () => Promise<unknown[]>
}

export type DrizzleLikeDelete = {
  where: (clause: unknown) => DrizzleLikeDelete
  returning?: () => Promise<unknown[]>
  run?: () => Promise<unknown>
}

export type DrizzleDatabase = {
  select(selection?: Record<string, unknown>): DrizzleSelectBuilder
  insert(table: unknown): DrizzleLikeInsert
  update?(table: unknown): DrizzleLikeUpdate
  delete?(table: unknown): DrizzleLikeDelete
  run?(query: unknown): Promise<unknown>
  transaction?<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
}
