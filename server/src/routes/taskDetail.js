import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import express from 'express'
import multer from 'multer'

import {requireAuth} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query} from '../lib/db.js'
import {PERMISSION_READ, PERMISSION_WRITE, canReadProject, canWriteProject} from '../lib/permissions.js'
import {shapeUser} from '../lib/shape.js'
import {sniffMime} from '../lib/sniff.js'

export const taskDetailRouter = express.Router()
taskDetailRouter.use(requireAuth)

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {fileSize: config.maxFileSizeBytes},
})

/** Task plus a permission check on its parent project, in one step. */
async function loadTask(userId, taskId, level) {
	const task = await one('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId])
	if (!task) {
		return {status: 404, message: 'task not found'}
	}
	const allowed = level === PERMISSION_READ
		? await canReadProject(userId, task.project_id)
		: await canWriteProject(userId, task.project_id)
	if (!allowed) {
		return {status: 403, message: 'forbidden'}
	}
	return {task}
}

function blobPath(fileId) {
	return path.join(config.filesPath, String(fileId))
}

// --- comments ----------------------------------------------------------

taskDetailRouter.get('/tasks/:task(\\d+)/comments', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_READ)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const rows = await query(
			`SELECT c.id, c.comment, c.task_id, c.created, c.updated,
			        u.id AS author_id, u.username, u.name, u.email, u.created AS u_created, u.updated AS u_updated
			 FROM task_comments c JOIN users u ON u.id = c.author_id
			 WHERE c.task_id = ? ORDER BY c.created`,
			[found.task.id],
		)

		return res.json(rows.map(r => ({
			id: r.id,
			comment: r.comment,
			task_id: r.task_id,
			author: shapeUser({
				id: r.author_id, username: r.username, name: r.name, email: r.email,
				created: r.u_created, updated: r.u_updated,
			}),
			reactions: {},
			created: r.created,
			updated: r.updated,
		})))
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.put('/tasks/:task(\\d+)/comments', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const comment = String(req.body?.comment ?? '').trim()
		if (!comment) {
			return res.status(400).json({message: 'a comment cannot be empty'})
		}

		const result = await query(
			`INSERT INTO task_comments (comment, author_id, task_id, created, updated)
			 VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[comment, req.user.id, found.task.id],
		)
		const row = await one('SELECT * FROM task_comments WHERE id = ?', [result.insertId])
		const author = await one('SELECT id, username, name, email, created, updated FROM users WHERE id = ?', [req.user.id])
		return res.status(201).json({...row, author: shapeUser(author), reactions: {}})
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.post('/tasks/:task(\\d+)/comments/:comment(\\d+)', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_READ)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const existing = await one('SELECT * FROM task_comments WHERE id = ? AND task_id = ?',
			[Number(req.params.comment), found.task.id])
		if (!existing) {
			return res.status(404).json({message: 'comment not found'})
		}
		// Only the author edits their own words, regardless of project permission.
		if (existing.author_id !== req.user.id) {
			return res.status(403).json({message: 'forbidden'})
		}

		const comment = String(req.body?.comment ?? '').trim()
		if (!comment) {
			return res.status(400).json({message: 'a comment cannot be empty'})
		}

		await query('UPDATE task_comments SET comment = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[comment, existing.id])
		const row = await one('SELECT * FROM task_comments WHERE id = ?', [existing.id])
		const author = await one('SELECT id, username, name, email, created, updated FROM users WHERE id = ?', [existing.author_id])
		return res.json({...row, author: shapeUser(author), reactions: {}})
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.delete('/tasks/:task(\\d+)/comments/:comment(\\d+)', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_READ)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const existing = await one('SELECT * FROM task_comments WHERE id = ? AND task_id = ?',
			[Number(req.params.comment), found.task.id])
		if (!existing) {
			return res.status(404).json({message: 'comment not found'})
		}

		// The author, or someone who can administer the project, may remove it.
		const isAuthor = existing.author_id === req.user.id
		if (!isAuthor && !(await canWriteProject(req.user.id, found.task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}

		await query('DELETE FROM task_comments WHERE id = ?', [existing.id])
		return res.json({message: 'comment deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- attachments -------------------------------------------------------

async function shapeAttachment(row) {
	const file = await one('SELECT id, name, mime, size, created FROM files WHERE id = ?', [row.file_id])
	const creator = await one('SELECT id, username, name, email, created, updated FROM users WHERE id = ?', [row.created_by_id])
	return {
		id: row.id,
		task_id: row.task_id,
		file,
		created_by: shapeUser(creator),
		created: row.created,
	}
}

taskDetailRouter.get('/tasks/:task(\\d+)/attachments', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_READ)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}
		const rows = await query('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created', [found.task.id])
		return res.json(await Promise.all(rows.map(shapeAttachment)))
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.put('/tasks/:task(\\d+)/attachments', upload.array('files'), async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		await fsp.mkdir(config.filesPath, {recursive: true})
		const success = []
		const errors = []

		for (const f of req.files ?? []) {
			try {
				// Same rule as project storage: the uploader's Content-Type is not
				// trusted, the bytes decide.
				const mime = sniffMime(f.buffer)
				const fileRow = await query(
					`INSERT INTO files (name, mime, size, created_by_id, created)
					 VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
					[f.originalname, mime, f.size, req.user.id],
				)
				await fsp.writeFile(blobPath(fileRow.insertId), f.buffer)

				const attRow = await query(
					`INSERT INTO task_attachments (task_id, file_id, created_by_id, created)
					 VALUES (?, ?, ?, UTC_TIMESTAMP())`,
					[found.task.id, fileRow.insertId, req.user.id],
				)
				const row = await one('SELECT * FROM task_attachments WHERE id = ?', [attRow.insertId])
				success.push(await shapeAttachment(row))
			} catch (err) {
				errors.push(`${f.originalname}: ${err.message}`)
			}
		}

		return res.status(200).json({success, errors})
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.get('/tasks/:task(\\d+)/attachments/:attachment(\\d+)', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_READ)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const att = await one('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?',
			[Number(req.params.attachment), found.task.id])
		if (!att) {
			return res.status(404).json({message: 'attachment not found'})
		}

		const file = await one('SELECT id, name, mime FROM files WHERE id = ?', [att.file_id])
		const p = blobPath(att.file_id)
		if (!file || !fs.existsSync(p)) {
			return res.status(404).json({message: 'file missing from storage'})
		}

		// Always an attachment: this endpoint has no allowlist, so nothing here is
		// ever rendered inline on our origin.
		res.setHeader('Content-Type', file.mime || 'application/octet-stream')
		res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file.name)}"`)
		res.setHeader('X-Content-Type-Options', 'nosniff')
		return res.sendFile(path.resolve(p))
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.delete('/tasks/:task(\\d+)/attachments/:attachment(\\d+)', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const att = await one('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?',
			[Number(req.params.attachment), found.task.id])
		if (!att) {
			return res.status(404).json({message: 'attachment not found'})
		}

		await query('DELETE FROM task_attachments WHERE id = ?', [att.id])
		await query('DELETE FROM files WHERE id = ?', [att.file_id])
		await fsp.rm(blobPath(att.file_id), {force: true})
		return res.json({message: 'attachment deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- relations ---------------------------------------------------------

// Mirrors the Go RelationKind values; the client sends these strings.
const RELATION_KINDS = [
	'unknown', 'subtask', 'parenttask', 'related', 'duplicateof', 'duplicates',
	'blocking', 'blocked', 'precedes', 'follows', 'copiedfrom', 'copiedto',
]

// Adding one side implies the other, so both rows are written together.
const INVERSE = {
	subtask: 'parenttask', parenttask: 'subtask',
	related: 'related', duplicateof: 'duplicates', duplicates: 'duplicateof',
	blocking: 'blocked', blocked: 'blocking',
	precedes: 'follows', follows: 'precedes',
	copiedfrom: 'copiedto', copiedto: 'copiedfrom',
}

taskDetailRouter.put('/tasks/:task(\\d+)/relations', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const otherId = Number(req.body?.other_task_id)
		const kindName = String(req.body?.relation_kind ?? '').toLowerCase()
		const kind = RELATION_KINDS.indexOf(kindName)
		if (!Number.isInteger(otherId) || kind < 1) {
			return res.status(400).json({message: 'other_task_id and a valid relation_kind are required'})
		}
		if (otherId === found.task.id) {
			return res.status(400).json({message: 'a task cannot relate to itself'})
		}

		// The other task must be readable, or a relation could leak its existence.
		const other = await loadTask(req.user.id, otherId, PERMISSION_READ)
		if (other.status) {
			return res.status(other.status).json({message: 'the other task is not accessible'})
		}

		const inverse = RELATION_KINDS.indexOf(INVERSE[kindName] ?? 'related')
		for (const [a, b, k] of [[found.task.id, otherId, kind], [otherId, found.task.id, inverse]]) {
			await query(
				`INSERT INTO task_relations (task_id, other_task_id, relation_kind, created_by_id, created)
				 SELECT ?, ?, ?, ?, UTC_TIMESTAMP() FROM DUAL
				 WHERE NOT EXISTS (SELECT 1 FROM task_relations
				                   WHERE task_id = ? AND other_task_id = ? AND relation_kind = ?)`,
				[a, b, k, req.user.id, a, b, k],
			)
		}

		return res.status(201).json({task_id: found.task.id, other_task_id: otherId, relation_kind: kindName})
	} catch (err) {
		return next(err)
	}
})

taskDetailRouter.delete('/tasks/:task(\\d+)/relations/:kind/:otherTask(\\d+)', async (req, res, next) => {
	try {
		const found = await loadTask(req.user.id, Number(req.params.task), PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const kindName = String(req.params.kind).toLowerCase()
		const kind = RELATION_KINDS.indexOf(kindName)
		const otherId = Number(req.params.otherTask)
		const inverse = RELATION_KINDS.indexOf(INVERSE[kindName] ?? 'related')

		await query('DELETE FROM task_relations WHERE task_id = ? AND other_task_id = ? AND relation_kind = ?',
			[found.task.id, otherId, kind])
		await query('DELETE FROM task_relations WHERE task_id = ? AND other_task_id = ? AND relation_kind = ?',
			[otherId, found.task.id, inverse])

		return res.json({message: 'relation deleted'})
	} catch (err) {
		return next(err)
	}
})

/** Relations for a task, grouped by kind — the shape the detail view renders. */
export async function relationsForTask(taskId) {
	const rows = await query(
		`SELECT r.relation_kind, t.* FROM task_relations r
		 JOIN tasks t ON t.id = r.other_task_id
		 WHERE r.task_id = ? AND t.deleted_at IS NULL`,
		[taskId],
	)
	const grouped = {}
	for (const r of rows) {
		const kind = RELATION_KINDS[r.relation_kind] ?? 'related'
		grouped[kind] ??= []
		grouped[kind].push({id: r.id, title: r.title, done: Boolean(r.done), project_id: r.project_id})
	}
	return grouped
}

// --- reminders ---------------------------------------------------------

export async function remindersForTask(taskId) {
	const rows = await query(
		'SELECT reminder, relative_period, relative_to FROM task_reminders WHERE task_id = ? ORDER BY reminder',
		[taskId],
	)
	return rows.map(r => ({
		reminder: r.reminder,
		relative_period: r.relative_period ?? 0,
		relative_to: r.relative_to ?? '',
	}))
}

/** Replaces a task's reminders. The client always sends the full set. */
export async function replaceReminders(taskId, reminders) {
	await query('DELETE FROM task_reminders WHERE task_id = ?', [taskId])
	for (const r of reminders ?? []) {
		if (!r?.reminder && !r?.relative_to) {
			continue
		}
		await query(
			`INSERT INTO task_reminders (task_id, reminder, created, relative_period, relative_to)
			 VALUES (?, ?, UTC_TIMESTAMP(), ?, ?)`,
			[taskId, r.reminder ? new Date(r.reminder) : new Date(), r.relative_period ?? 0, r.relative_to ?? ''],
		)
	}
}

// --- attachments/comments on the task payload --------------------------

export async function attachmentsForTask(taskId) {
	const rows = await query('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created', [taskId])
	return Promise.all(rows.map(shapeAttachment))
}
