import mysql from 'mysql2/promise'
import {config} from './config.js'

/**
 * One shared pool. The schema is the one the Go server's migrations created —
 * this server does not own or alter it, so existing data keeps working.
 */
export const pool = mysql.createPool({
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
	database: config.db.database,
	charset: 'utf8mb4',
	waitForConnections: true,
	// Shared hosts cap connections well below the driver default; going over the
	// account limit shows up as intermittent failures under load, not at boot.
	connectionLimit: Number(process.env.VIKUNJA_DATABASE_MAXOPENCONNECTIONS ?? 10),
	timezone: 'Z',
	dateStrings: false,
})

export async function query(sql, params = []) {
	const [rows] = await pool.execute(sql, params)
	return rows
}

export async function one(sql, params = []) {
	const rows = await query(sql, params)
	return rows[0] ?? null
}

/** Runs fn inside a transaction, rolling back on any throw. */
export async function transaction(fn) {
	const conn = await pool.getConnection()
	try {
		await conn.beginTransaction()
		const result = await fn(conn)
		await conn.commit()
		return result
	} catch (err) {
		await conn.rollback()
		throw err
	} finally {
		conn.release()
	}
}

export async function ping() {
	const row = await one('SELECT VERSION() AS version')
	return row.version
}
