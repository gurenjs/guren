import { Resource } from '@guren/core'
import { Task } from '../../Models/Task.js'
import type { TaskRecord } from '../../Models/Task.js'
import type { WithRelations } from '@guren/orm'

type TaskWithOwner = WithRelations<typeof Task, 'owner'>

export interface TaskResourceData extends Record<string, unknown> {
  id: number
  title: string
  description: string | null
  completed: boolean
  notificationArtifactPath: string
  broadcastChannels: {
    public: string
    private: string
  }
  createdAt: string
  updatedAt: string
  owner?: { id: number | undefined; name: string | undefined }
}

export class TaskResource extends Resource<TaskRecord | TaskWithOwner> {
  toArray(): TaskResourceData {
    const task = this.resource
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      completed: task.completed,
      notificationArtifactPath: `notifications/tasks/${task.id}.json`,
      broadcastChannels: {
        public: 'tasks',
        private: `users.${task.userId}.tasks`,
      },
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
