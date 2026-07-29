import fsp from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import mysql from 'mysql2/promise'

import {config} from './config.js'
import {query} from './db.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Creates the schema if the database is empty.
 *
 * Runs at startup rather than as a build step, because a build phase often has
 * no database credentials — many platforms only inject environment variables at
 * runtime, so doing this at build time turns a missing variable into a failed
 * deploy.
 *
 * On an existing database this costs one SHOW TABLES and does nothing else.
 *
 * @returns {Promise<'created'|'present'|'failed'>}
 */
export async function ensureSchema() {
	let tables
	try {
		tables = await query('SHOW TABLES')
	} catch (err) {
		console.error('[fsoc] could not inspect the database:', err.message)
		return 'failed'
	}

	if (tables.length > 0) {
		return 'present'
	}

	console.log('[fsoc] the database is empty — creating the schema')

	// multipleStatements stays off in the app's pool, since it widens what a
	// single injected string could do. It is enabled only for this file, which
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
		const sql = await fsp.readFile(path.join(here, '..', '..', 'schema.sql'), 'utf8')
		await conn.query(sql)

		const [after] = await conn.query('SHOW TABLES')
		console.log(`[fsoc] created ${after.length} tables`)
		console.log('[fsoc] no accounts exist yet. Create the first one with:')
		console.log('[fsoc]   npm run create-admin -- <username> <email> <password>')
		return 'created'
	} catch (err) {
		console.error('[fsoc] creating the schema failed:', err.message)
		return 'failed'
	} finally {
		await conn.end()
	}
}
