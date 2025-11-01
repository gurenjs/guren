import { Route } from '@guren/server'
import HomeController from '../app/Http/Controllers/HomeController'

Route.get('/', [HomeController, 'index'])
