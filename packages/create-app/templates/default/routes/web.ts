import { Route } from '@guren/server'
import HomeController from '../app/Http/Controllers/HomeController.js'

Route.get('/', [HomeController, 'index'])
