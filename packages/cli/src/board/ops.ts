/**
 * The operations a board is edited by (RFC 0041 §2), as the schema a list is checked against:
 * the canvas posts a list and `board:apply` reads one. `apply.ts` applies them, with no zod, so
 * the canvas bundles the applier without the schema.
 */

import { z } from 'zod'

import { BOARD_EXTENT, BOARD_MAX_OPS } from './geometry'
import { BoardLinkSchema, BoardNoteSchema, BoardSectionSchema } from './schema'

export { applyBoardOps, type AppliedBoardOps, type DroppedBoardOp } from './apply'

const { id: IdSchema, kind: KindSchema, text: TextSchema } = BoardNoteSchema.shape

// Off-grid values are snapped on apply: a pointer position is rarely a multiple of the grid.
const UnitSchema = z.number().min(0).max(BOARD_EXTENT)
const PointSchema = z.strictObject({ x: UnitSchema, y: UnitSchema })
const RectSchema = PointSchema.extend({ width: UnitSchema, height: UnitSchema })

export const BoardOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('add'),
    id: IdSchema,
    kind: KindSchema,
    text: TextSchema,
    at: PointSchema.optional(),
    after: IdSchema.optional(),
    section: IdSchema.optional(),
    about: z.array(IdSchema).optional(),
  }),
  z.strictObject({
    op: z.literal('edit'),
    id: IdSchema,
    text: TextSchema.optional(),
    kind: KindSchema.optional(),
    section: IdSchema.nullable().optional(),
    about: z.array(IdSchema).optional(),
  }),
  z.strictObject({ op: z.literal('move'), id: IdSchema, x: UnitSchema, y: UnitSchema }),
  z.strictObject({ op: z.literal('remove'), id: IdSchema }),
  z.strictObject({ op: z.literal('connect'), from: IdSchema, to: IdSchema, kind: z.literal('async').optional() }),
  z.strictObject({ op: z.literal('disconnect'), from: IdSchema, to: IdSchema }),
  z.strictObject({ op: z.literal('link'), id: IdSchema, link: BoardLinkSchema.nullable() }),
  z.strictObject({ op: z.literal('section'), id: IdSchema, title: BoardSectionSchema.shape.title, at: RectSchema.optional() }),
  z.strictObject({ op: z.literal('unsection'), id: IdSchema }),
])

export type BoardOp = z.infer<typeof BoardOpSchema>

const BoardOpListSchema = z.array(BoardOpSchema).max(BOARD_MAX_OPS)

/** What `board:apply` and the canvas send: the list, bare or under `ops`. */
export const BoardOpsDocumentSchema = z.union([BoardOpListSchema, z.strictObject({ ops: BoardOpListSchema })])

export function boardOpsOf(document: z.infer<typeof BoardOpsDocumentSchema>): BoardOp[] {
  return Array.isArray(document) ? document : document.ops
}
