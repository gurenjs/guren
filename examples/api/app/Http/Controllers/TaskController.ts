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

  async store(): Promise<Response> {
    const userId = this.getUserId()
    const data = await this.validateBody(CreateTaskSchema)

    const task = await Task.create({
      ...data,
      userId,
      completed: false,
    })

    const cacheService = this.#cacheService()
    await cacheService.invalidateUserTasks(userId)

    await this.make('events').emit(new TaskCreated(task!, userId))

    return this.created({
      data: new TaskResource(task!).toJSON(),
    })
  }

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

    const cacheService = this.#cacheService()
    await cacheService.invalidateTask(task.id, userId)

    if (!wasCompleted && refreshed?.completed === true) {
      await this.make('events').emit(new TaskCompleted(refreshed, userId))
    }

    return this.json({
      data: new TaskResource(refreshed!).toJSON(),
    })
  }

  async destroy(): Promise<Response> {
    const userId = this.getUserId()
    const { id } = this.validateParams(TaskIdParamSchema)

    const task = await Task.first({ id, userId })
    if (!task) {
      return this.json({ error: 'Task not found' }, { status: 404 })
    }

    await Task.delete({ id: task.id })

    const cacheService = this.#cacheService()
    await cacheService.invalidateTask(task.id, userId)

    return this.json({ message: 'Task deleted' })
  }
}
