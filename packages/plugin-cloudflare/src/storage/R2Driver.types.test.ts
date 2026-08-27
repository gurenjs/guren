import { describe, expect, test } from 'bun:test'
import type { R2Bucket } from '@cloudflare/workers-types'
import type { R2BucketLike } from './R2Driver'

// Compile-time contract: the real Workers `R2Bucket` must satisfy the
// structural `R2BucketLike` the driver is written against. If workers-types
// renames or retypes a member this driver reads, `tsc --noEmit` fails here
// instead of the driver failing at runtime.
type Assignable<From, To> = From extends To ? true : never
const bucketIsBucketLike: Assignable<R2Bucket, R2BucketLike> = true

// And the other direction for what the driver *passes in*: every option the
// driver hands to put()/list() must be a legal option for the real binding.
type PutOptionsOf<B> = B extends { put(key: string, value: never, options?: infer O): unknown } ? O : never
type ListOptionsOf<B> = B extends { list(options?: infer O): unknown } ? O : never
type GetOptionsOf<B> = B extends { get(key: string, options?: infer O): unknown } ? O : never
const putOptionsFit: Assignable<PutOptionsOf<R2BucketLike>, PutOptionsOf<R2Bucket>> = true
const listOptionsFit: Assignable<ListOptionsOf<R2BucketLike>, ListOptionsOf<R2Bucket>> = true
const getOptionsFit: Assignable<GetOptionsOf<R2BucketLike>, GetOptionsOf<R2Bucket>> = true

describe('R2BucketLike', () => {
  test('is satisfied by @cloudflare/workers-types R2Bucket (checked at typecheck time)', () => {
    expect(bucketIsBucketLike && putOptionsFit && listOptionsFit && getOptionsFit).toBe(true)
  })
})
