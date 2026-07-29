import bcrypt from 'bcryptjs'

import {one, query} from './lib/db.js'

/**
 * Creates the first administrator on a fresh instance.
 *
 * Registration is off by default and the admin panel needs an admin to reach it,
 * so without this a new database has no way in. Run from a shell on the server:
 *
 *   npm run create-admin -- alice alice@example.com 'a good password'
 *
 * Taking the password as an argument means it lands in shell history; on a
 * shared machine, prefix the command with a space or unset HISTFILE.
 */
async function main() {
	const [username, email, password] = process.argv.slice(2)

	if (!username || !email || !password) {
		console.error('usage: npm run create-admin -- <username> <email> <password>')
		process.exitCode = 1
		return
	}
	if (/\s/.test(username)) {
		console.error('the username cannot contain spaces')
		process.exitCode = 1
		return
	}
	if (!email.includes('@')) {
		console.error('that does not look like an email address')
		process.exitCode = 1
		return
	}
	// bcrypt ignores anything past 72 bytes, so a longer password would give a
	// false sense of strength.
	if (password.length < 8 || Buffer.byteLength(password) > 72) {
		console.error('the password must be at least 8 characters and at most 72 bytes')
		process.exitCode = 1
		return
	}

	const clash = await one('SELECT id, username FROM users WHERE username = ? OR email = ?',
		[username, email])
	if (clash) {
		console.error(`a user already exists with that username or email (${clash.username})`)
		process.exitCode = 1
		return
	}

	const result = await query(
		`INSERT INTO users (username, password, email, name, status, is_admin, language, created, updated)
		 VALUES (?, ?, ?, '', 0, 1, 'en', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
		[username, await bcrypt.hash(password, 11), email],
	)

	// A default project, so the first login is not an empty screen with no way
	// to create one that is obvious.
	const {createDefaultViews} = await import('./routes/projects.js')
	const project = await query(
		`INSERT INTO projects (title, description, identifier, hex_color, owner_id,
		                       parent_project_id, is_archived, position, created, updated)
		 VALUES ('Inbox', '', '', '', ?, NULL, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
		[result.insertId],
	)
	await createDefaultViews(project.insertId, result.insertId)

	console.log(`created administrator "${username}" (id ${result.insertId}) with an Inbox project`)
	process.exit(0)
}

main().catch(err => {
	console.error('could not create the administrator:', err.message)
	process.exitCode = 1
})
