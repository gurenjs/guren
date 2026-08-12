import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostResource } from '../Resources/PostResource.js'

const LATEST_POST_COUNT = 3

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const latest = await Post.newQuery()
      .with('author')
      .orderBy('id', 'desc')
      .limit(LATEST_POST_COUNT)
      .get()

    return this.inertia(
      pages.Home,
      { latest: latest.map((post) => new PostResource(post).toJSON()) },
      { title: '__APP_TITLE__' },
    )
  }
}
