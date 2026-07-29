import { Command } from '@guren/core'
import { Post } from '../../Models/Post.js'

export default class PostStatsCommand extends Command {
  static signature = 'posts:stats {--limit=5}'
  static description = 'Summarise the posts currently in the database'

  async handle(): Promise<void> {
    const posts = await Post.all()
    const limit = Number(this.option('limit'))

    this.info(`${posts.length} post(s) stored`)
    this.table(
      ['ID', 'Title'],
      posts.slice(0, limit).map((post) => [String(post.id), post.title]),
    )
  }
}
