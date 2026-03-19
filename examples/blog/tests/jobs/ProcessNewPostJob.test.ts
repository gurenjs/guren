import { describe, expect, it, vi } from 'vitest'

const { emitMock, postFindMock, userFindMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  postFindMock: vi.fn(),
  userFindMock: vi.fn(),
}))
vi.mock('@guren/server', () => ({
  Event: class {},
  Job: class {},
  createEventManager: () => ({ emit: emitMock }),
}))

vi.mock('../../app/Models/Post.js', () => ({
  Post: { find: postFindMock },
}))

vi.mock('../../app/Models/User.js', () => ({
  User: { find: userFindMock },
}))

import { ProcessNewPostJob } from '../../app/Jobs/ProcessNewPostJob.js'

describe('ProcessNewPostJob', () => {
  it('skips when the post is missing', async () => {
    postFindMock.mockResolvedValue(null)

    const job = new ProcessNewPostJob()
    await job.handle({ postId: 1 })

    expect(emitMock).not.toHaveBeenCalled()
  })

  it('emits the PostCreated event when data is available', async () => {
    postFindMock.mockResolvedValue({ id: 1, authorId: 10 })
    userFindMock.mockResolvedValue({ id: 10, name: 'Ada' })

    const job = new ProcessNewPostJob()
    await job.handle({ postId: 1 })

    expect(emitMock).toHaveBeenCalled()
  })
})
