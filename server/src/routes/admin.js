import bcrypt from 'bcryptjs'
import express from 'express'

import {requireAuth, requireRealUser} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query} from '../lib/db.js'
import {sendMail} from '../lib/mail.js'

export const adminRouter = express.Router()
adminRouter.use(requireAuth)
adminRouter.use(requireRealUser)

/**
 * Every route below can read or change any account on the instance, so the
 * admin flag is checked once here for the whole router rather than per route —
 * a new route added later is protected by default instead of by remembering.
 *
 * The flag comes from the database on each request, not from the token: a token
 * issued before someone's admin rights were revoked would otherwise keep them.
 */
adminRouter.use(async (req, res, next) => {
	try {
		const user = await one('SELECT is_admin FROM users WHERE id = ?', [req.user.id])
		if (!user?.is_admin) {
			return res.status(403).json({message: 'this area is for administrators'})
		}
		req.user.isAdmin = true
		return next()
	} catch (err) {
		return next(err)
	}
})

function shapeAdminUser(row) {
	return {
		id: row.id,
		username: row.username,
		name: row.name ?? '',
		email: row.email,
		status: Number(row.status ?? 0),
		is_admin: Boolean(row.is_admin),
		issuer: row.issuer ?? 'local',
		subject: row.subject ?? '',
		created: row.created,
		updated: row.updated,
		deletion_scheduled_at: row.deletion_scheduled_at ?? null,
	}
}

// --- overview ----------------------------------------------------------

adminRouter.get('/admin/overview', async (req, res, next) => {
	try {
		const count = async sql => Number((await one(`SELECT COUNT(*) AS n FROM ${sql}`)).n)

		const [users, projects, tasks, teams, linkShares, teamShares, userShares] = await Promise.all([
			count('users'),
			count('projects'),
			count('tasks WHERE deleted_at IS NULL'),
			count('teams'),
			count('link_shares'),
			count('team_projects'),
			count('users_projects'),
		])

		return res.json({
			users,
			projects,
			tasks,
			teams,
			shares: {
				link_shares: linkShares,
				team_shares: teamShares,
				user_shares: userShares,
			},
			// This build carries no licence system; the client renders the panel
			// from these fields, so they are reported honestly rather than faked.
			license: {
				licensed: false,
				instance_id: '',
				features: [],
				max_users: 0,
				expires_at: new Date(0),
				validated_at: new Date(0),
				last_check_failed: false,
			},
		})
	} catch (err) {
		return next(err)
	}
})

// --- users -------------------------------------------------------------

adminRouter.get('/admin/users', async (req, res, next) => {
	try {
		const search = String(req.query.s ?? '').trim()
		const params = []
		let where = ''
		if (search) {
			where = 'WHERE username LIKE ? OR email LIKE ? OR name LIKE ?'
			params.push(`%${search}%`, `%${search}%`, `%${search}%`)
		}

		const rows = await query(
			`SELECT id, username, name, email, status, is_admin, issuer, subject,
			        deletion_scheduled_at, created, updated
			 FROM users ${where} ORDER BY id`,
			params,
		)
		res.paginate?.(rows.length, Math.max(rows.length, 1))
		return res.json(rows.map(shapeAdminUser))
	} catch (err) {
		return next(err)
	}
})

adminRouter.post('/admin/users', async (req, res, next) => {
	try {
		const username = String(req.body?.username ?? '').trim()
		const email = String(req.body?.email ?? '').trim()
		const password = String(req.body?.password ?? '')

		if (!username || /\s/.test(username)) {
			return res.status(400).json({message: 'a username is required and cannot contain spaces'})
		}
		if (!email.includes('@')) {
			return res.status(400).json({message: 'a valid email address is required'})
		}
		// bcrypt silently ignores anything past 72 bytes, so a longer password
		// would give a false sense of strength.
		if (password.length < 8 || Buffer.byteLength(password) > 72) {
			return res.status(400).json({message: 'the password must be at least 8 characters and at most 72 bytes'})
		}

		const clash = await one('SELECT id FROM users WHERE username = ? OR email = ?', [username, email])
		if (clash) {
			return res.status(409).json({message: 'that username or email is already taken'})
		}

		const result = await query(
			`INSERT INTO users (username, password, email, name, status, is_admin, language,
			                    created, updated)
			 VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[
				username, await bcrypt.hash(password, 11), email,
				String(req.body?.name ?? ''),
				// status 1 means "must confirm by email"; skipping that is the point
				// of an admin creating the account directly.
				req.body?.skip_email_confirm === false ? 1 : 0,
				req.body?.is_admin ? 1 : 0,
				String(req.body?.language ?? 'en'),
			],
		)

		const row = await one('SELECT * FROM users WHERE id = ?', [result.insertId])
		return res.status(201).json(shapeAdminUser(row))
	} catch (err) {
		return next(err)
	}
})

/** Guards against an admin locking themselves out of their own instance. */
function refuseSelf(req, res, targetId, what) {
	if (Number(targetId) === Number(req.user.id)) {
		res.status(400).json({message: `you cannot ${what} your own account`})
		return true
	}
	return false
}

adminRouter.patch('/admin/users/:id(\\d+)/admin', async (req, res, next) => {
	try {
		const id = Number(req.params.id)
		if (refuseSelf(req, res, id, 'change the admin flag on')) {
			return undefined
		}

		const isAdmin = req.body?.is_admin
		if (typeof isAdmin !== 'boolean') {
			return res.status(400).json({message: 'is_admin must be true or false'})
		}

		// Removing the last admin would leave nobody able to restore one.
		if (!isAdmin) {
			const others = await one(
				'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id <> ?', [id])
			if (Number(others.n) === 0) {
				return res.status(400).json({message: 'that is the only administrator left'})
			}
		}

		const result = await query('UPDATE users SET is_admin = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[isAdmin ? 1 : 0, id])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'user not found'})
		}

		const row = await one('SELECT * FROM users WHERE id = ?', [id])
		return res.json(shapeAdminUser(row))
	} catch (err) {
		return next(err)
	}
})

adminRouter.patch('/admin/users/:id(\\d+)/status', async (req, res, next) => {
	try {
		const id = Number(req.params.id)
		if (refuseSelf(req, res, id, 'change the status of')) {
			return undefined
		}

		const status = Number(req.body?.status)
		// 0 active, 1 awaiting email confirmation, 2 disabled, 3 locked.
		if (![0, 1, 2, 3].includes(status)) {
			return res.status(400).json({message: 'status must be 0, 1, 2 or 3'})
		}

		const result = await query('UPDATE users SET status = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[status, id])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'user not found'})
		}

		// A disabled or locked account must not keep working on tokens it already
		// holds, so its sessions go too.
		if (status === 2 || status === 3) {
			await query('DELETE FROM sessions WHERE user_id = ?', [id]).catch(() => {})
		}

		const row = await one('SELECT * FROM users WHERE id = ?', [id])
		return res.json(shapeAdminUser(row))
	} catch (err) {
		return next(err)
	}
})

adminRouter.patch('/admin/users/:id(\\d+)/password', async (req, res, next) => {
	try {
		const id = Number(req.params.id)
		const newPassword = String(req.body?.new_password ?? '')
		if (newPassword.length < 8 || Buffer.byteLength(newPassword) > 72) {
			return res.status(400).json({message: 'the password must be at least 8 characters and at most 72 bytes'})
		}

		const result = await query('UPDATE users SET password = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[await bcrypt.hash(newPassword, 11), id])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'user not found'})
		}

		// Their existing sessions were authorised with the old password.
		await query('DELETE FROM sessions WHERE user_id = ?', [id]).catch(() => {})

		const row = await one('SELECT * FROM users WHERE id = ?', [id])
		return res.json(shapeAdminUser(row))
	} catch (err) {
		return next(err)
	}
})

adminRouter.post('/admin/users/:id(\\d+)/password-reset-email', async (req, res, next) => {
	try {
		const user = await one('SELECT id, username, email FROM users WHERE id = ?', [Number(req.params.id)])
		if (!user) {
			return res.status(404).json({message: 'user not found'})
		}
		if (!user.email) {
			return res.status(400).json({message: 'that account has no email address'})
		}

		const {createPasswordResetToken} = await import('./account.js')
		const token = await createPasswordResetToken(user.id)

		const sent = await sendMail({
			to: user.email,
			subject: 'Reset your FSOC password',
			heading: 'Password reset',
			lines: ['An administrator started a password reset for your account.'],
			action: {
				label: 'Choose a new password',
				url: new URL(`/password-reset?token=${token}`, config.publicUrl).toString(),
			},
		})

		if (!sent) {
			return res.status(503).json({message: 'no mail server is configured, so no email could be sent'})
		}
		return res.json({message: 'password reset email sent'})
	} catch (err) {
		return next(err)
	}
})

adminRouter.delete('/admin/users/:id(\\d+)', async (req, res, next) => {
	try {
		const id = Number(req.params.id)
		if (refuseSelf(req, res, id, 'delete')) {
			return undefined
		}

		const user = await one('SELECT id FROM users WHERE id = ?', [id])
		if (!user) {
			return res.status(404).json({message: 'user not found'})
		}

		// 'scheduled' gives the same grace period a self-service deletion gets, so
		// an accidental click is recoverable.
		if (String(req.query.mode ?? 'scheduled') === 'now') {
			const {deleteUserAccount} = await import('./account.js')
			const result = await deleteUserAccount(id)
			return res.json({message: 'user deleted', ...result})
		}

		const scheduled = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
		await query('UPDATE users SET deletion_scheduled_at = ? WHERE id = ?', [scheduled, id])
		return res.json({message: 'deletion scheduled', scheduled_at: scheduled})
	} catch (err) {
		return next(err)
	}
})

// --- projects ----------------------------------------------------------

adminRouter.get('/admin/projects', async (req, res, next) => {
	try {
		const search = String(req.query.s ?? '').trim()
		const params = []
		let where = ''
		if (search) {
			where = 'WHERE p.title LIKE ?'
			params.push(`%${search}%`)
		}

		// Counts come from grouped subqueries rather than a query per project,
		// which on an instance with many projects would be one round trip each.
		const rows = await query(
			`SELECT p.id, p.title, p.description, p.identifier, p.hex_color, p.owner_id,
			        p.parent_project_id, p.is_archived, p.position, p.created, p.updated,
			        u.username AS owner_username, u.name AS owner_name, u.email AS owner_email,
			        COALESCE(t.n, 0) AS task_count,
			        COALESCE(us.n, 0) AS user_share_count,
			        COALESCE(ts.n, 0) AS team_share_count
			 FROM projects p
			 LEFT JOIN users u ON u.id = p.owner_id
			 LEFT JOIN (SELECT project_id, COUNT(*) n FROM tasks WHERE deleted_at IS NULL GROUP BY project_id) t
			        ON t.project_id = p.id
			 LEFT JOIN (SELECT project_id, COUNT(*) n FROM users_projects GROUP BY project_id) us
			        ON us.project_id = p.id
			 LEFT JOIN (SELECT project_id, COUNT(*) n FROM team_projects GROUP BY project_id) ts
			        ON ts.project_id = p.id
			 ${where}
			 ORDER BY p.id`,
			params,
		)

		res.paginate?.(rows.length, Math.max(rows.length, 1))
		return res.json(rows.map(r => ({
			id: r.id,
			title: r.title,
			description: r.description ?? '',
			identifier: r.identifier ?? '',
			hex_color: r.hex_color ?? '',
			owner_id: r.owner_id,
			owner: r.owner_username
				? {id: r.owner_id, username: r.owner_username, name: r.owner_name ?? '', email: r.owner_email}
				: null,
			parent_project_id: r.parent_project_id ?? 0,
			is_archived: Boolean(r.is_archived),
			position: r.position,
			task_count: Number(r.task_count),
			user_share_count: Number(r.user_share_count),
			team_share_count: Number(r.team_share_count),
			created: r.created,
			updated: r.updated,
		})))
	} catch (err) {
		return next(err)
	}
})

adminRouter.patch('/admin/projects/:id(\\d+)/owner', async (req, res, next) => {
	try {
		const projectId = Number(req.params.id)
		const ownerId = Number(req.body?.owner_id)
		if (!Number.isInteger(ownerId) || ownerId < 1) {
			return res.status(400).json({message: 'owner_id is required'})
		}

		const project = await one('SELECT id, owner_id FROM projects WHERE id = ?', [projectId])
		if (!project) {
			return res.status(404).json({message: 'project not found'})
		}
		const newOwner = await one('SELECT id FROM users WHERE id = ?', [ownerId])
		if (!newOwner) {
			return res.status(404).json({message: 'that user does not exist'})
		}
		if (project.owner_id === ownerId) {
			return res.status(400).json({message: 'they already own it'})
		}

		await query('UPDATE projects SET owner_id = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[ownerId, projectId])
		// An explicit share for the new owner is now redundant, and would show them
		// twice in the access list.
		await query('DELETE FROM users_projects WHERE project_id = ? AND user_id = ?', [projectId, ownerId])
		// The previous owner keeps admin access rather than losing the project.
		await query(
			`INSERT INTO users_projects (user_id, project_id, permission, created, updated)
			 VALUES (?, ?, 2, UTC_TIMESTAMP(), UTC_TIMESTAMP())
			 ON DUPLICATE KEY UPDATE permission = 2, updated = UTC_TIMESTAMP()`,
			[project.owner_id, projectId],
		)

		const row = await one('SELECT * FROM projects WHERE id = ?', [projectId])
		return res.json({...row, is_archived: Boolean(row.is_archived)})
	} catch (err) {
		return next(err)
	}
})
