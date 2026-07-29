import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

import express from 'express'

import {requireAuth, requireRealUser, verifyPassword} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query, transaction} from '../lib/db.js'
import {sendMail} from '../lib/mail.js'
import {visibleProjectIds} from '../lib/permissions.js'

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
