import { describe, expect, it } from 'vitest'
import { ListTasksQuerySchema, TaskIdParamSchema } from '../../app/Http/Validators/TaskValidator.js'

describe('TaskValidator', () => {
  it('defaults query params for task listing', () => {
    const result = ListTasksQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.per_page).toBe(15)
    expect(result.completed).toBe('all')
  })

  it('coerces task id params', () => {
    const result = TaskIdParamSchema.parse({ id: '12' })
    expect(result.id).toBe(12)
  })
})
