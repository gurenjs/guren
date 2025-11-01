import { Application } from '@guren/server'
import DatabaseProvider from '../app/Providers/DatabaseProvider'

const app = new Application({
  providers: [DatabaseProvider],
})

export default app
