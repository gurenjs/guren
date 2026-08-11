import { createConnection } from 'mysql2/promise'

const target = new URL(process.env.DATABASE_URL ?? '')
const dbName = decodeURIComponent(target.pathname.slice(1))
const admin = new URL(target.toString())
admin.pathname = '/'

const connection = await createConnection(admin.toString())
await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName.replaceAll('`', '``')}\``)
await connection.end()
console.log(`Database ${dbName} ready`)
