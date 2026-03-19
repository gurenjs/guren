import { Resource } from '@guren/server'
import type { TaskRecord } from '../../Models/Task.js'
import type { TaskWithOwner } from '../../Models/Task.js'

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
