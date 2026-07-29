import fsp from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import mysql from 'mysql2/promise'

import {config} from './lib/config.js'

/**
 * Creates the schema in an empty database.
 *
 * The Go server built this through 129 migrations; this server has no migration
 * runner, so a fresh database is set up from schema.sql instead. Re-running is a
 * no-op — every statement is IF NOT EXISTS or INSERT IGNORE — so it is safe to
 * call on every deploy.
 */
const here = path.dirname(fileURLToPath(import.meta.url))

async function main() {
	const file = path.join(here, '..', 'schema.sql')
	const sql = await fsp.readFile(file, 'utf8')

	// multipleStatements is off in the app's pool on purpose — it widens what a
	// single injected string could do. It is enabled only here, for a file that
	// ships with the server and takes no user input.
	const conn = await mysql.createConnection({
		host: config.db.host,
		port: config.db.port,
		user: config.db.user,
		password: config.db.password,
		database: config.db.database,
		multipleStatements: true,
	})

	try {
		const before = await conn.query('SHOW TABLES')
		const had = before[0].length
		console.log(`[fsoc] database ${config.db.database} has ${had} table(s)`)

		if (had > 0) {
			console.log('[fsoc] applying schema.sql anyway — it is idempotent, so this changes nothing that exists')
		}

		await conn.query(sql)

		const after = await conn.query('SHOW TABLES')
		console.log(`[fsoc] done: ${after[0].length} table(s)`)

		if (after[0].length === had && had > 0) {
			console.log('[fsoc] schema was already current')
		} else {
			console.log(`[fsoc] created ${after[0].length - had} table(s)`)
		}

		// An empty database has no accounts, and registration is off by default,
		// so say plainly how to get the first one rather than leaving a dead login.
		const [users] = await conn.query('SELECT COUNT(*) AS n FROM users')
		if (Number(users[0].n) === 0) {
			console.log('')
			console.log('[fsoc] there are no user accounts yet. Create the first one with:')
			console.log('[fsoc]   npm run create-admin -- <username> <email> <password>')
		}
	} finally {
		await conn.end()
	}
}

main().catch(err => {
	console.error('[fsoc] schema setup failed:', err.message)
	if (err.code === 'ER_ACCESS_DENIED_ERROR') {
		console.error('[fsoc]   the database rejected these credentials.')
		console.error('[fsoc]   on a managed host this is also what you get when the server\'s IP')
		console.error('[fsoc]   is not in the remote-access allowlist — the error is the same for both.')
	}
	process.exitCode = 1
})
