import { z } from 'zod'

export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  description: z.string().max(1000).optional(),
})

export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  completed: z.boolean().optional(),
})

export const TaskIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListTasksQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(15),
  completed: z.enum(['true', 'false', 'all']).optional().default('all'),
})

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>
