import { Task } from './Task.js'
import { User } from './User.js'

// Register relationships here so both models have been defined before linking them.
User.hasMany('tasks', Task, 'userId', 'id')
Task.belongsTo('owner', User, 'userId', 'id')
