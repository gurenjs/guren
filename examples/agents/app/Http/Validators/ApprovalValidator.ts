import { z } from 'zod'

export const ApprovalIdParamSchema = z.object({
  id: z.uuid(),
})

/** No fields yet: a schema so the body is still validated, a JSON object. */
export const ResolveApprovalSchema = z.object({})

/** How old a settled request must be before `prune` removes it. */
export const PruneApprovalsSchema = z.object({
  olderThanDays: z.coerce.number().int().min(0).max(365).optional(),
})
