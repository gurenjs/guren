import { Post } from './Post.js'
import { User } from './User.js'

// Register relationships here so both models have been defined before linking them.
User.hasMany('posts', Post, 'authorId', 'id')
Post.belongsTo('author', User, 'authorId', 'id')
