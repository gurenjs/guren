import {
  Controller,
  parseRequestPayload,
  formatValidationErrors,
  getApiToken,
  paginate,
} from '@guren/server'
import { Task } from '../../Models/Task.js'
import { TaskResource } from '../Resources/TaskResource.js'
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  TaskIdParamSchema,
  ListTasksQuerySchema,
} from '../Validators/TaskValidator.js'
import { getEventManager } from '../../Providers/EventServiceProvider.js'
import { TaskCreated } from '../../Events/TaskCreated.js'
import { TaskCompleted } from '../../Events/TaskCompleted.js'
import { getTaskCacheService } from '../../Services/TaskCacheService.js'

export default class TaskController extends Controller {
  private getUserId(): number | null {
    const tokenInfo = getApiToken(this.ctx)
    return tokenInfo ? Number(tokenInfo.userId) : null
  }

  // GET /api/tasks
  async index(): Promise<Response> {
    const userId = this.getUserId()
    if (!userId) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const queryResult = ListTasksQuerySchema.safeParse({
      page: this.request.query('page'),
      per_page: this.request.query('per_page'),
      completed: this.request.query('completed'),
    })

    if (!queryResult.success) {
      return this.json({ errors: formatValidationErrors(queryResult.error) }, { status: 422 })
    }

    const { page, per_page: perPage, completed } = queryResult.data

    // Build where conditions
    type WhereConditions = { userId: number; completed?: boolean }
    const where: WhereConditions = { userId }
    if (completed === 'true') where.completed = true
    if (completed === 'false') where.completed = false

    const { data: tasks, meta } = await Task.paginate({
      page,
      perPage,
      where,
      orderBy: ['createdAt', 'desc'],
    })

    const paginatorInstance = paginate(tasks, meta.total, perPage, page)
      .withPath('/api/tasks')
      .withQuery({ per_page: String(perPage) })

    return this.json(paginatorInstance.toResource(TaskResource))
  }

  // POST /api/tasks
  async store(): Promise<Response> {
    const userId = this.getUserId()
    if (!userId) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const payload = await parseRequestPayload(this.ctx)
    const result = CreateTaskSchema.safeParse(payload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    const task = await Task.create({
      ...result.data,
      userId,
      completed: false,
    })

    if (!task) {
      return this.json({ error: 'Failed to create task' }, { status: 500 })
    }

    // Invalidate cache
    const cacheService = getTaskCacheService()
    await cacheService.invalidateUserTasks(userId)

    // Emit TaskCreated event
    const events = getEventManager()
    await events.emit(new TaskCreated(task, userId))

    return this.json({
      data: new TaskResource(task).toJSON(),
    }, { status: 201 })
  }

  // GET /api/tasks/:id
  async show(): Promise<Response> {
    const userId = this.getUserId()
    if (!userId) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const paramResult = TaskIdParamSchema.safeParse({ id: this.request.param('id') })
    if (!paramResult.success) {
      return this.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const task = await Task.first({ id: paramResult.data.id, userId })

    if (!task) {
      return this.json({ error: 'Task not found' }, { status: 404 })
    }

    return this.json({
      data: new TaskResource(task).toJSON(),
    })
  }

  // PUT /api/tasks/:id
  async update(): Promise<Response> {
    const userId = this.getUserId()
    if (!userId) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const paramResult = TaskIdParamSchema.safeParse({ id: this.request.param('id') })
    if (!paramResult.success) {
      return this.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const task = await Task.first({ id: paramResult.data.id, userId })
    if (!task) {
      return this.json({ error: 'Task not found' }, { status: 404 })
    }

    const wasCompleted = task.completed
    const payload = await parseRequestPayload(this.ctx)
    const result = UpdateTaskSchema.safeParse(payload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    await Task.update({ id: task.id }, {
      ...result.data,
      updatedAt: new Date(),
    })

    const refreshed = await Task.find(task.id)

    // Invalidate cache
    const cacheService = getTaskCacheService()
    await cacheService.invalidateTask(task.id, userId)

    // Emit TaskCompleted event if task was just completed
    if (!wasCompleted && refreshed?.completed === true) {
      const events = getEventManager()
      await events.emit(new TaskCompleted(refreshed, userId))
    }

    return this.json({
      data: new TaskResource(refreshed!).toJSON(),
    })
  }

  // DELETE /api/tasks/:id
  async destroy(): Promise<Response> {
    const userId = this.getUserId()
    if (!userId) {
      return this.json({ error: 'Unauthenticated' }, { status: 401 })
    }

    const paramResult = TaskIdParamSchema.safeParse({ id: this.request.param('id') })
    if (!paramResult.success) {
      return this.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const task = await Task.first({ id: paramResult.data.id, userId })
    if (!task) {
      return this.json({ error: 'Task not found' }, { status: 404 })
    }

    await Task.delete({ id: task.id })

    // Invalidate cache
    const cacheService = getTaskCacheService()
    await cacheService.invalidateTask(task.id, userId)

    return this.json({ message: 'Task deleted' })
  }
}
