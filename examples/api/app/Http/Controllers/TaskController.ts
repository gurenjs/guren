import { Controller, paginate } from '@guren/core'
import { Task } from '../../Models/Task.js'
import { TaskResource } from '../Resources/TaskResource.js'
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  TaskIdParamSchema,
  ListTasksQuerySchema,
} from '../Validators/TaskValidator.js'
import { TaskCreated } from '../../Events/TaskCreated.js'
import { TaskCompleted } from '../../Events/TaskCompleted.js'
import { TaskCacheService } from '../../Services/TaskCacheService.js'

export default class TaskController extends Controller {
  #cacheService(): TaskCacheService {
    return new TaskCacheService(this.make('cache'))
  }

  private getUserId(): number {
    return Number(this.apiTokenUserId())
  }

  // GET /api/tasks
  async index(): Promise<Response> {
    const userId = this.getUserId()
    const { page, per_page: perPage, completed } = this.validateQuery(ListTasksQuerySchema)
    const cacheService = this.#cacheService()
    const result = await cacheService.getUserTasks(
      userId,
      page,
      perPage,
      completed === 'all'
        ? {}
        : { completed: completed === 'true' },
    )

    const paginatorInstance = paginate(result, {
      path: '/api/tasks',
      query: {
        per_page: String(result.meta.perPage),
        ...(completed === 'all' ? {} : { completed }),
      },
    })

    return this.json(paginatorInstance.toResource(TaskResource))
  }

  // POST /api/tasks
  async store(): Promise<Response> {
    const userId = this.getUserId()
    const data = await this.validateBody(CreateTaskSchema)

    const task = await Task.create({
      ...data,
      userId,
      completed: false,
    })

    // Invalidate cache
    const cacheService = this.#cacheService()
    await cacheService.invalidateUserTasks(userId)

    // Emit TaskCreated event
    await this.make('events').emit(new TaskCreated(task!, userId))

    return this.created({
      data: new TaskResource(task!).toJSON(),
    })
  }

  // GET /api/tasks/:id
  async show(): Promise<Response> {
    const userId = this.getUserId()
    const { id } = this.validateParams(TaskIdParamSchema)

    const task = await Task.first({ id, userId })
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
    const { id } = this.validateParams(TaskIdParamSchema)

    const task = await Task.first({ id, userId })
    if (!task) {
      return this.json({ error: 'Task not found' }, { status: 404 })
    }

    const wasCompleted = task.completed
    const data = await this.validateBody(UpdateTaskSchema)

    await Task.update({ id: task.id }, {
      ...data,
      updatedAt: new Date(),
    })

    const refreshed = await Task.find(task.id)

    // Invalidate cache
    const cacheService = this.#cacheService()
    await cacheService.invalidateTask(task.id, userId)

    // Emit TaskCompleted event if task was just completed
    if (!wasCompleted && refreshed?.completed === true) {
      await this.make('events').emit(new TaskCompleted(refreshed, userId))
    }

    return this.json({
      data: new TaskResource(refreshed!).toJSON(),
    })
  }

  // DELETE /api/tasks/:id
  async destroy(): Promise<Response> {
    const userId = this.getUserId()
    const { id } = this.validateParams(TaskIdParamSchema)

    const task = await Task.first({ id, userId })
    if (!task) {
      return this.json({ error: 'Task not found' }, { status: 404 })
    }

    await Task.delete({ id: task.id })

    // Invalidate cache
    const cacheService = this.#cacheService()
    await cacheService.invalidateTask(task.id, userId)

    return this.json({ message: 'Task deleted' })
  }
}
