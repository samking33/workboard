import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

import express from 'express'
import multer from 'multer'

import {requireAuth, requireRealUser, verifyPassword} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query, transaction} from '../lib/db.js'
import {sendMail} from '../lib/mail.js'
import {visibleProjectIds} from '../lib/permissions.js'
import {sniffMime} from '../lib/sniff.js'

export const accountRouter = express.Router()
accountRouter.use(requireAuth)
accountRouter.use(requireRealUser)

/**
 * Export and deletion both hand over or destroy everything a user owns, so both
 * re-check the password even though the request is already authenticated — a
 * stolen token alone must not be enough.
 */
async function passwordMatches(userId, password) {
	if (!password) {
		return false
	}
	const user = await one('SELECT password FROM users WHERE id = ?', [userId])
	return user ? verifyPassword(password, user.password) : false
}

// --- data export -------------------------------------------------------

/** Everything the user can see, as one JSON document. */
async function buildExport(userId) {
	const user = await one(
		`SELECT id, username, name, email, created, updated, language, timezone,
		        email_reminders_enabled, overdue_tasks_reminders_enabled
		 FROM users WHERE id = ?`,
		[userId],
	)

	const projectIds = await visibleProjectIds(userId)
	const projects = []

	for (const projectId of projectIds) {
		const project = await one('SELECT * FROM projects WHERE id = ?', [projectId])
		if (!project) {
			continue
		}

		const tasks = await query(
			'SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY `index`',
			[projectId],
		)

		for (const task of tasks) {
			task.assignees = await query(
				`SELECT u.id, u.username FROM task_assignees ta JOIN users u ON u.id = ta.user_id
				 WHERE ta.task_id = ?`, [task.id])
			task.labels = await query(
				`SELECT l.id, l.title, l.hex_color FROM label_tasks lt JOIN labels l ON l.id = lt.label_id
				 WHERE lt.task_id = ?`, [task.id])
			task.comments = await query(
				`SELECT c.id, c.comment, c.created, c.updated, u.username AS author
				 FROM task_comments c JOIN users u ON u.id = c.author_id
				 WHERE c.task_id = ? ORDER BY c.created`, [task.id])
			task.attachments = await query(
				`SELECT ta.id, f.name, f.mime, f.size, ta.created
				 FROM task_attachments ta JOIN files f ON f.id = ta.file_id
				 WHERE ta.task_id = ?`, [task.id])
			task.reminders = await query(
				'SELECT reminder, relative_period, relative_to FROM task_reminders WHERE task_id = ?', [task.id])
			task.related_tasks = await query(
				'SELECT other_task_id, relation_kind FROM task_relations WHERE task_id = ?', [task.id])
		}

		project.tasks = tasks
		project.views = await query('SELECT * FROM project_views WHERE project_id = ?', [projectId])
		project.storage = await query(
			`SELECT si.id, si.title, si.kind, si.url, si.created, f.name AS file_name, f.mime, f.size
			 FROM storage_items si LEFT JOIN files f ON f.id = si.file_id
			 WHERE si.project_id = ?`,
			[projectId],
		)
		projects.push(project)
	}

	const labels = await query('SELECT * FROM labels WHERE created_by_id = ?', [userId])
	const filters = await query('SELECT * FROM saved_filters WHERE owner_id = ?', [userId])

	return {
		exported_at: new Date().toISOString(),
		format_version: 1,
		user,
		projects,
		labels,
		saved_filters: filters,
	}
}

function exportPath(userId) {
	return path.join(config.filesPath, `export-user-${userId}.json.gz`)
}

// The settings page asks for this before offering the download button.
accountRouter.get('/user/export', async (req, res, next) => {
	try {
		const file = exportPath(req.user.id)
		if (!fs.existsSync(file)) {
			return res.json({id: 0, created: null, size: 0})
		}
		const stat = await fsp.stat(file)
		return res.json({id: req.user.id, created: stat.mtime, size: stat.size})
	} catch (err) {
		return next(err)
	}
})

/**
 * Zone names come from the platform rather than a bundled list, so they stay
 * current with the system's tz database.
 */
accountRouter.get('/user/timezones', (_req, res) => {
	const zones = typeof Intl.supportedValuesOf === 'function'
		? Intl.supportedValuesOf('timeZone')
		: ['UTC']
	return res.json(zones)
})

accountRouter.post('/user/export/request', async (req, res, next) => {
	try {
		if (!(await passwordMatches(req.user.id, req.body?.password))) {
			return res.status(412).json({message: 'please confirm your password'})
		}

		const data = await buildExport(req.user.id)

		// Gzipped on disk rather than held in memory: an account with thousands of
		// tasks would otherwise be built twice over in RAM per request.
		await fsp.mkdir(config.filesPath, {recursive: true})
		const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data, null, 2)))
		await fsp.writeFile(exportPath(req.user.id), gz)

		const user = await one('SELECT email FROM users WHERE id = ?', [req.user.id])
		if (user?.email) {
			await sendMail({
				to: user.email,
				subject: 'Your data export is ready',
				heading: 'Your export is ready to download',
				lines: [
					`It covers ${data.projects.length} project(s).`,
					'It stays available until you request a new one.',
				],
				action: {label: 'Download it', url: new URL('/user/export/download', config.publicUrl).toString()},
			})
		}

		return res.json({
			message: 'export ready',
			projects: data.projects.length,
			size_bytes: gz.length,
		})
	} catch (err) {
		return next(err)
	}
})

accountRouter.post('/user/export/download', async (req, res, next) => {
	try {
		if (!(await passwordMatches(req.user.id, req.body?.password))) {
			return res.status(412).json({message: 'please confirm your password'})
		}

		// Path is built from the authenticated id, never from anything the caller
		// sent, so there is nothing here to traverse with.
		const file = exportPath(req.user.id)
		if (!fs.existsSync(file)) {
			return res.status(404).json({message: 'no export has been requested yet'})
		}

		res.setHeader('Content-Type', 'application/gzip')
		res.setHeader('Content-Disposition', `attachment; filename="fsoc-export-${req.user.username}.json.gz"`)
		res.setHeader('X-Content-Type-Options', 'nosniff')
		return res.sendFile(path.resolve(file))
	} catch (err) {
		return next(err)
	}
})

// --- account deletion --------------------------------------------------

/**
 * Deletion is scheduled, not immediate: the Go server gives a grace period so a
 * compromised session cannot destroy an account before the owner notices the
 * confirmation email.
 */
const DELETION_GRACE_DAYS = 7

accountRouter.post('/user/deletion/request', async (req, res, next) => {
	try {
		if (!(await passwordMatches(req.user.id, req.body?.password))) {
			return res.status(412).json({message: 'please confirm your password'})
		}

		const scheduled = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000)
		await query('UPDATE users SET deletion_scheduled_at = ? WHERE id = ?', [scheduled, req.user.id])

		const user = await one('SELECT email, username FROM users WHERE id = ?', [req.user.id])
		if (user?.email) {
			await sendMail({
				to: user.email,
				subject: 'Your FSOC account is scheduled for deletion',
				heading: 'Account deletion requested',
				lines: [
					`Your account and everything you own will be deleted on ${scheduled.toDateString()}.`,
					'If this was not you, cancel it and change your password.',
				],
				action: {label: 'Cancel the deletion', url: new URL('/user/settings/deletion', config.publicUrl).toString()},
			})
		}

		return res.json({message: 'deletion scheduled', scheduled_at: scheduled})
	} catch (err) {
		return next(err)
	}
})

accountRouter.post('/user/deletion/cancel', async (req, res, next) => {
	try {
		if (!(await passwordMatches(req.user.id, req.body?.password))) {
			return res.status(412).json({message: 'please confirm your password'})
		}
		await query('UPDATE users SET deletion_scheduled_at = NULL WHERE id = ?', [req.user.id])
		return res.json({message: 'deletion cancelled'})
	} catch (err) {
		return next(err)
	}
})

accountRouter.get('/user/deletion', async (req, res, next) => {
	try {
		const user = await one('SELECT deletion_scheduled_at FROM users WHERE id = ?', [req.user.id])
		return res.json({scheduled_at: user?.deletion_scheduled_at ?? null})
	} catch (err) {
		return next(err)
	}
})

/**
 * Removes a user and everything only they hold.
 *
 * Projects shared with other people are transferred rather than deleted — one
 * person leaving must not take the team's work with them.
 */
export async function deleteUserAccount(userId) {
	const owned = await query('SELECT id FROM projects WHERE owner_id = ?', [userId])
	const transferred = []
	const removable = []

	for (const project of owned) {
		const others = await query(
			`SELECT user_id FROM users_projects WHERE project_id = ? AND permission = 2 AND user_id <> ?
			 ORDER BY user_id LIMIT 1`,
			[project.id, userId],
		)
		if (others.length > 0) {
			transferred.push({projectId: project.id, to: others[0].user_id})
		} else {
			removable.push(project.id)
		}
	}

	for (const t of transferred) {
		await query('UPDATE projects SET owner_id = ? WHERE id = ?', [t.to, t.projectId])
		await query('DELETE FROM users_projects WHERE project_id = ? AND user_id = ?', [t.projectId, t.to])
	}

	const {deleteProjectCascade} = await import('./projects.js')
	for (const projectId of removable) {
		await deleteProjectCascade(projectId)
	}

	await transaction(async conn => {
		for (const [table, column] of [
			['task_assignees', 'user_id'], ['users_projects', 'user_id'], ['team_members', 'user_id'],
			['subscriptions', 'user_id'], ['favorites', 'user_id'], ['reactions', 'user_id'],
			['notifications', 'notifiable_id'], ['api_tokens', 'owner_id'], ['totp', 'user_id'],
			['user_tokens', 'user_id'], ['sessions', 'user_id'], ['saved_filters', 'owner_id'],
			['task_unread_statuses', 'user_id'], ['time_entries', 'user_id'],
		]) {
			await conn.query(`DELETE FROM ${table} WHERE ${column} = ?`, [userId])
		}
		await conn.query('DELETE FROM users WHERE id = ?', [userId])
	})

	await fsp.rm(exportPath(userId), {force: true}).catch(() => {})

	return {transferred: transferred.length, deleted: removable.length}
}

// --- password change ---------------------------------------------------

accountRouter.post('/user/password', async (req, res, next) => {
	try {
		if (!(await passwordMatches(req.user.id, req.body?.old_password))) {
			return res.status(412).json({message: 'your current password is not correct'})
		}

		const newPassword = String(req.body?.new_password ?? '')
		if (newPassword.length < 8) {
			return res.status(400).json({message: 'the new password must be at least 8 characters'})
		}

		const bcrypt = (await import('bcryptjs')).default
		const hash = await bcrypt.hash(newPassword, 11)
		await query('UPDATE users SET password = ?, updated = UTC_TIMESTAMP() WHERE id = ?', [hash, req.user.id])

		// Every other session was authorised with the old password.
		await query('DELETE FROM sessions WHERE user_id = ? AND id <> ?',
			[req.user.id, req.user.sid ?? 0]).catch(() => {})

		return res.json({message: 'password changed'})
	} catch (err) {
		return next(err)
	}
})

// Kept alongside deletion so the token used to confirm one is generated the
// same way as the other.
export function newConfirmationToken() {
	return crypto.randomBytes(32).toString('hex')
}

// --- sessions ----------------------------------------------------------

accountRouter.get('/user/sessions', async (req, res, next) => {
	try {
		const rows = await query(
			`SELECT id, device_info, ip_address, is_long_session, last_active, created
			 FROM sessions WHERE user_id = ? ORDER BY last_active DESC, id DESC`,
			[req.user.id],
		)
		// token_hash is never returned: it is the credential itself.
		return res.json(rows.map(r => ({
			id: r.id,
			device_info: r.device_info ?? '',
			ip_address: r.ip_address ?? '',
			is_long_session: Boolean(r.is_long_session),
			last_active: r.last_active,
			created: r.created,
		})))
	} catch (err) {
		return next(err)
	}
})

accountRouter.delete('/user/sessions/:id(\\d+)', async (req, res, next) => {
	try {
		// Scoped to the caller, so one user cannot revoke another's session.
		const result = await query('DELETE FROM sessions WHERE id = ? AND user_id = ?',
			[Number(req.params.id), req.user.id])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'session not found'})
		}
		return res.json({message: 'session revoked'})
	} catch (err) {
		return next(err)
	}
})

// --- email address -----------------------------------------------------

accountRouter.post('/user/settings/email', async (req, res, next) => {
	try {
		// Changing the address is how an account is taken over if a session leaks,
		// so it needs the password even though the request is authenticated.
		if (!(await passwordMatches(req.user.id, req.body?.password))) {
			return res.status(412).json({message: 'please confirm your password'})
		}

		const email = String(req.body?.new_email ?? '').trim()
		if (!email.includes('@') || email.length > 250) {
			return res.status(400).json({message: 'that does not look like an email address'})
		}

		const clash = await one('SELECT id FROM users WHERE email = ? AND id <> ?', [email, req.user.id])
		if (clash) {
			return res.status(409).json({message: 'that email address is already in use'})
		}

		await query('UPDATE users SET email = ?, updated = UTC_TIMESTAMP() WHERE id = ?', [email, req.user.id])
		return res.json({message: 'email address updated'})
	} catch (err) {
		return next(err)
	}
})

// --- avatar ------------------------------------------------------------

const AVATAR_PROVIDERS = ['initials', 'gravatar', 'marble', 'upload', 'default']

accountRouter.get('/user/settings/avatar', async (req, res, next) => {
	try {
		const user = await one('SELECT avatar_provider FROM users WHERE id = ?', [req.user.id])
		return res.json({avatar_provider: user?.avatar_provider || 'initials'})
	} catch (err) {
		return next(err)
	}
})

accountRouter.post('/user/settings/avatar', async (req, res, next) => {
	try {
		const provider = String(req.body?.avatar_provider ?? '').trim()
		if (!AVATAR_PROVIDERS.includes(provider)) {
			return res.status(400).json({message: `avatar_provider must be one of: ${AVATAR_PROVIDERS.join(', ')}`})
		}

		if (provider === 'upload') {
			const user = await one('SELECT avatar_file_id FROM users WHERE id = ?', [req.user.id])
			if (!user?.avatar_file_id) {
				return res.status(400).json({message: 'upload an image before choosing that provider'})
			}
		}

		await query('UPDATE users SET avatar_provider = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[provider, req.user.id])
		return res.json({avatar_provider: provider})
	} catch (err) {
		return next(err)
	}
})

const avatarUpload = multer({
	storage: multer.memoryStorage(),
	// An avatar is displayed at a few dozen pixels; anything large is a mistake
	// or an attempt to fill the disk.
	limits: {fileSize: 5 * 1024 * 1024},
})

accountRouter.put('/user/settings/avatar/upload', avatarUpload.any(), async (req, res, next) => {
	try {
		const file = req.file ?? (req.files ?? [])[0]
		if (!file) {
			return res.status(400).json({message: 'no image was uploaded'})
		}

		// Same rule as every other upload: the type comes from the bytes, never
		// from the uploader, so an HTML payload cannot be stored as an image.
		const mime = sniffMime(file.buffer)
		if (!mime.startsWith('image/')) {
			return res.status(415).json({message: 'that file is not an image'})
		}

		await fsp.mkdir(config.filesPath, {recursive: true})
		const inserted = await query(
			'INSERT INTO files (name, mime, size, created_by_id, created) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
			[file.originalname, mime, file.size, req.user.id],
		)
		await fsp.writeFile(path.join(config.filesPath, String(inserted.insertId)), file.buffer)

		const previous = await one('SELECT avatar_file_id FROM users WHERE id = ?', [req.user.id])
		await query(
			'UPDATE users SET avatar_file_id = ?, avatar_provider = \'upload\', updated = UTC_TIMESTAMP() WHERE id = ?',
			[inserted.insertId, req.user.id],
		)

		// Replacing an avatar should not leave the old blob behind forever.
		if (previous?.avatar_file_id) {
			await query('DELETE FROM files WHERE id = ?', [previous.avatar_file_id]).catch(() => {})
			await fsp.rm(path.join(config.filesPath, String(previous.avatar_file_id)), {force: true}).catch(() => {})
		}

		return res.json({message: 'avatar updated', avatar_provider: 'upload'})
	} catch (err) {
		return next(err)
	}
})

// --- password reset by email -------------------------------------------

const RESET_TOKEN_KIND = 1 // TokenPasswordReset in the Go enum
const RESET_TTL_MS = 60 * 60 * 1000

/**
 * Stored hashed, like every other credential here, so a database read cannot
 * mint a reset. Also used by the admin panel's "send reset email".
 */
export async function createPasswordResetToken(userId) {
	const token = crypto.randomBytes(32).toString('hex')
	const hash = crypto.createHash('sha256').update(token).digest('hex')

	// Only the newest reset should work, otherwise an older leaked link stays live.
	await query('DELETE FROM user_tokens WHERE user_id = ? AND kind = ?', [userId, RESET_TOKEN_KIND])
	await query('INSERT INTO user_tokens (user_id, token, kind, created) VALUES (?, ?, ?, UTC_TIMESTAMP())',
		[userId, hash, RESET_TOKEN_KIND])

	return token
}

// Public: someone who has forgotten their password cannot be authenticated.
export const publicAccountRouter = express.Router()

publicAccountRouter.post('/user/password/token', async (req, res, next) => {
	try {
		const login = String(req.body?.username ?? req.body?.email ?? '').trim()
		const user = login
			? await one('SELECT id, email FROM users WHERE username = ? OR email = ?', [login, login])
			: null

		if (user?.email) {
			const token = await createPasswordResetToken(user.id)
			await sendMail({
				to: user.email,
				subject: 'Reset your FSOC password',
				heading: 'Password reset',
				lines: ['Use the link below to choose a new password. It expires in an hour.'],
				action: {
					label: 'Choose a new password',
					url: new URL(`/password-reset?token=${token}`, config.publicUrl).toString(),
				},
			})
		}

		// Always the same answer: a different response for a known account would
		// turn this endpoint into a way to test which usernames exist.
		return res.json({message: 'if that account exists, a reset link has been sent'})
	} catch (err) {
		return next(err)
	}
})

publicAccountRouter.post('/user/password/reset', async (req, res, next) => {
	try {
		const token = String(req.body?.token ?? '')
		const newPassword = String(req.body?.new_password ?? '')

		if (newPassword.length < 8 || Buffer.byteLength(newPassword) > 72) {
			return res.status(400).json({message: 'the password must be at least 8 characters and at most 72 bytes'})
		}

		const hash = crypto.createHash('sha256').update(token).digest('hex')
		const row = await one(
			'SELECT id, user_id, created FROM user_tokens WHERE token = ? AND kind = ?',
			[hash, RESET_TOKEN_KIND],
		)
		if (!row || Date.now() - new Date(row.created).getTime() > RESET_TTL_MS) {
			return res.status(400).json({message: 'that reset link is invalid or has expired'})
		}

		const bcrypt = (await import('bcryptjs')).default
		await query('UPDATE users SET password = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[await bcrypt.hash(newPassword, 11), row.user_id])

		// The token is single-use, and every existing session predates the reset —
		// if the account was compromised, this is what locks the intruder out.
		await query('DELETE FROM user_tokens WHERE id = ?', [row.id])
		await query('DELETE FROM sessions WHERE user_id = ?', [row.user_id]).catch(() => {})

		return res.json({message: 'password changed, you can log in now'})
	} catch (err) {
		return next(err)
	}
})

// --- email confirmation ------------------------------------------------

const CONFIRM_TOKEN_KIND = 2 // TokenEmailConfirm

publicAccountRouter.post('/user/confirm', async (req, res, next) => {
	try {
		const token = String(req.body?.token ?? '')
		const hash = crypto.createHash('sha256').update(token).digest('hex')

		const row = await one('SELECT id, user_id FROM user_tokens WHERE token = ? AND kind = ?',
			[hash, CONFIRM_TOKEN_KIND])
		if (!row) {
			return res.status(400).json({message: 'that confirmation link is invalid'})
		}

		// status 0 is an active account.
		await query('UPDATE users SET status = 0, updated = UTC_TIMESTAMP() WHERE id = ?', [row.user_id])
		await query('DELETE FROM user_tokens WHERE id = ?', [row.id])

		return res.json({message: 'email confirmed'})
	} catch (err) {
		return next(err)
	}
})

publicAccountRouter.post('/user/deletion/confirm', async (req, res, next) => {
	try {
		const token = String(req.body?.token ?? '')
		const hash = crypto.createHash('sha256').update(token).digest('hex')

		const row = await one('SELECT id, user_id FROM user_tokens WHERE token = ? AND kind = 3', [hash])
		if (!row) {
			return res.status(400).json({message: 'that link is invalid or has already been used'})
		}

		const scheduled = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
		await query('UPDATE users SET deletion_scheduled_at = ? WHERE id = ?', [scheduled, row.user_id])
		await query('DELETE FROM user_tokens WHERE id = ?', [row.id])

		return res.json({message: 'deletion confirmed', scheduled_at: scheduled})
	} catch (err) {
		return next(err)
	}
})
