import { Resource } from '@guren/server'
import { Task } from '../../Models/Task.js'
import type { TaskRecord } from '../../Models/Task.js'
import type { WithRelations } from '@guren/orm'

type TaskWithOwner = WithRelations<typeof Task, 'owner'>

export class TaskResource extends Resource<TaskRecord | TaskWithOwner> {
  toArray() {
    const task = this.resource
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      completed: task.completed,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      // Conditionally include owner if loaded
      owner: this.whenLoaded('owner', () => ({
        id: (task as TaskWithOwner).owner?.id,
        name: (task as TaskWithOwner).owner?.name,
      })),
    }
  }
}
