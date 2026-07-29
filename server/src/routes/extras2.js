import express from 'express'
import multer from 'multer'

import {requireAuth, requireRealUser} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query} from '../lib/db.js'
import {
	PERMISSION_ADMIN,
	PERMISSION_READ,
	PERMISSION_WRITE,
	canReadProject,
	canWriteProject,
	requireProject,
} from '../lib/permissions.js'
import {shapeTask, shapeUser} from '../lib/shape.js'
import {sniffMime} from '../lib/sniff.js'
import addTaskToViews from '../lib/taskViews.js'

export const extras2Router = express.Router()
extras2Router.use(requireAuth)

// --- saved filters -----------------------------------------------------

/**
 * A saved filter is presented to the client as a project with a negative id
 * (`-(filterId + 1)`), so the same views can render it. Only the owner sees one.
 */
function shapeFilter(row) {
	let filters = {}
	try {
		filters = typeof row.filters === 'string' ? JSON.parse(row.filters) : (row.filters ?? {})
	} catch {
		filters = {}
	}
	return {
		id: row.id,
		title: row.title,
		description: row.description ?? '',
		filters,
		owner_id: row.owner_id,
		is_favorite: Boolean(row.is_favorite),
		created: row.created,
		updated: row.updated,
	}
}

extras2Router.get('/filters/:filter(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const row = await one('SELECT * FROM saved_filters WHERE id = ? AND owner_id = ?',
			[Number(req.params.filter), req.user.id])
		if (!row) {
			return res.status(404).json({message: 'filter not found'})
		}
		return res.json(shapeFilter(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.put('/filters', requireRealUser, async (req, res, next) => {
	try {
		const title = String(req.body?.title ?? '').trim()
		if (!title) {
			return res.status(400).json({message: 'a title is required'})
		}

		const result = await query(
			`INSERT INTO saved_filters (title, description, filters, owner_id, is_favorite, created, updated)
			 VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[
				title.slice(0, 250), String(req.body?.description ?? ''),
				JSON.stringify(req.body?.filters ?? {}), req.user.id,
				req.body?.is_favorite ? 1 : 0,
			],
		)

		const row = await one('SELECT * FROM saved_filters WHERE id = ?', [result.insertId])
		return res.status(201).json(shapeFilter(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/filters/:filter(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const filterId = Number(req.params.filter)
		const existing = await one('SELECT id FROM saved_filters WHERE id = ? AND owner_id = ?',
			[filterId, req.user.id])
		if (!existing) {
			return res.status(404).json({message: 'filter not found'})
		}

		const sets = []
		const params = []
		if (req.body?.title !== undefined) {
			const title = String(req.body.title).trim()
			if (!title) {
				return res.status(400).json({message: 'a title is required'})
			}
			sets.push('title = ?')
			params.push(title.slice(0, 250))
		}
		if (req.body?.description !== undefined) {
			sets.push('description = ?')
			params.push(String(req.body.description))
		}
		if (req.body?.filters !== undefined) {
			sets.push('filters = ?')
			params.push(JSON.stringify(req.body.filters))
		}
		if (req.body?.is_favorite !== undefined) {
			sets.push('is_favorite = ?')
			params.push(req.body.is_favorite ? 1 : 0)
		}

		if (sets.length > 0) {
			sets.push('updated = UTC_TIMESTAMP()')
			await query(`UPDATE saved_filters SET ${sets.join(', ')} WHERE id = ?`, [...params, filterId])
		}

		const row = await one('SELECT * FROM saved_filters WHERE id = ?', [filterId])
		return res.json(shapeFilter(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.delete('/filters/:filter(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const result = await query('DELETE FROM saved_filters WHERE id = ? AND owner_id = ?',
			[Number(req.params.filter), req.user.id])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'filter not found'})
		}
		return res.json({message: 'filter deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- project views -----------------------------------------------------

const VIEW_KINDS = ['list', 'gantt', 'table', 'kanban', 'storage']

function viewKindToNumber(value) {
	if (typeof value === 'number') {
		return VIEW_KINDS[value] ? value : null
	}
	const index = VIEW_KINDS.indexOf(String(value ?? '').toLowerCase())
	return index === -1 ? null : index
}

function shapeView(row) {
	return {
		id: row.id,
		title: row.title,
		project_id: row.project_id,
		view_kind: VIEW_KINDS[row.view_kind] ?? 'list',
		filter: row.filter,
		position: row.position,
		bucket_configuration_mode: row.bucket_configuration_mode,
		bucket_configuration: [],
		default_bucket_id: row.default_bucket_id ?? 0,
		done_bucket_id: row.done_bucket_id ?? 0,
		created: row.created,
		updated: row.updated,
	}
}

extras2Router.put(
	'/projects/:project(\\d+)/views',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const title = String(req.body?.title ?? '').trim()
			if (!title) {
				return res.status(400).json({message: 'a title is required'})
			}

			const kind = viewKindToNumber(req.body?.view_kind)
			if (kind === null) {
				return res.status(400).json({message: `view_kind must be one of: ${VIEW_KINDS.join(', ')}`})
			}

			const maxRow = await one(
				'SELECT COALESCE(MAX(position), 0) AS pos FROM project_views WHERE project_id = ?',
				[req.projectId],
			)

			const result = await query(
				`INSERT INTO project_views (title, project_id, view_kind, filter, position,
				                            bucket_configuration_mode, created, updated)
				 VALUES (?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[title.slice(0, 250), req.projectId, kind, req.body?.filter || null, Number(maxRow.pos) + 100],
			)

			// A kanban view without buckets is an unusable board, and every existing
			// task needs a card in it.
			if (kind === 3) {
				const bucketIds = []
				for (const [i, name] of ['To-Do', 'Doing', 'Done'].entries()) {
					const b = await query(
						`INSERT INTO buckets (title, project_view_id, \`limit\`, position, created_by_id, created, updated)
						 VALUES (?, ?, 0, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
						[name, result.insertId, (i + 1) * 100, req.user.id],
					)
					bucketIds.push(b.insertId)
				}
				await query('UPDATE project_views SET default_bucket_id = ?, done_bucket_id = ? WHERE id = ?',
					[bucketIds[0], bucketIds[2], result.insertId])
			}

			const tasks = await query(
				'SELECT id, `index`, done FROM tasks WHERE project_id = ? AND deleted_at IS NULL',
				[req.projectId],
			)
			for (const t of tasks) {
				await addTaskToViews(t.id, req.projectId, Number(t.index) || 1, Boolean(t.done))
			}

			const row = await one('SELECT * FROM project_views WHERE id = ?', [result.insertId])
			return res.status(201).json(shapeView(row))
		} catch (err) {
			return next(err)
		}
	},
)

extras2Router.post(
	'/projects/:project(\\d+)/views/:view(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const view = await one('SELECT * FROM project_views WHERE id = ? AND project_id = ?',
				[viewId, req.projectId])
			if (!view) {
				return res.status(404).json({message: 'view not found'})
			}

			const sets = []
			const params = []
			if (req.body?.title !== undefined) {
				const title = String(req.body.title).trim()
				if (!title) {
					return res.status(400).json({message: 'a title is required'})
				}
				sets.push('title = ?')
				params.push(title.slice(0, 250))
			}
			if (req.body?.filter !== undefined) {
				sets.push('filter = ?')
				params.push(req.body.filter || null)
			}
			if (req.body?.position !== undefined && Number.isFinite(Number(req.body.position))) {
				sets.push('position = ?')
				params.push(Number(req.body.position))
			}
			for (const [key, column] of [['default_bucket_id', 'default_bucket_id'], ['done_bucket_id', 'done_bucket_id']]) {
				if (req.body?.[key] === undefined) {
					continue
				}
				const bucketId = Number(req.body[key]) || 0
				// A bucket from another board would silently break done-syncing.
				if (bucketId) {
					const bucket = await one('SELECT id FROM buckets WHERE id = ? AND project_view_id = ?',
						[bucketId, viewId])
					if (!bucket) {
						return res.status(400).json({message: `${key} must be a bucket in this view`})
					}
				}
				sets.push(`${column} = ?`)
				params.push(bucketId || null)
			}

			// view_kind is deliberately not editable: the buckets, positions and
			// cards attached to a view assume its kind.
			if (sets.length > 0) {
				sets.push('updated = UTC_TIMESTAMP()')
				await query(`UPDATE project_views SET ${sets.join(', ')} WHERE id = ?`, [...params, viewId])
			}

			const row = await one('SELECT * FROM project_views WHERE id = ?', [viewId])
			return res.json(shapeView(row))
		} catch (err) {
			return next(err)
		}
	},
)

extras2Router.delete(
	'/projects/:project(\\d+)/views/:view(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const view = await one('SELECT id FROM project_views WHERE id = ? AND project_id = ?',
				[viewId, req.projectId])
			if (!view) {
				return res.status(404).json({message: 'view not found'})
			}

			const remaining = await one(
				'SELECT COUNT(*) AS n FROM project_views WHERE project_id = ? AND id <> ?',
				[req.projectId, viewId],
			)
			if (Number(remaining.n) === 0) {
				return res.status(400).json({message: 'a project needs at least one view'})
			}

			// Positions and cards belong to the view, not the task, so they go too.
			await query('DELETE FROM task_positions WHERE project_view_id = ?', [viewId])
			await query('DELETE FROM task_buckets WHERE project_view_id = ?', [viewId])
			await query('DELETE FROM buckets WHERE project_view_id = ?', [viewId])
			await query('DELETE FROM project_views WHERE id = ?', [viewId])

			return res.json({message: 'view deleted'})
		} catch (err) {
			return next(err)
		}
	},
)

// --- time tracking -----------------------------------------------------

function shapeEntry(row) {
	return {
		id: row.id,
		user_id: row.user_id,
		task_id: row.task_id,
		project_id: row.project_id,
		start_time: row.start_time,
		end_time: row.end_time,
		comment: row.comment ?? '',
		created: row.created,
		updated: row.updated,
	}
}

extras2Router.get('/time-entries', requireRealUser, async (req, res, next) => {
	try {
		// Only the caller's own entries: someone's working hours are theirs.
		const params = [req.user.id]
		let where = 'te.user_id = ?'

		if (req.query.task_id) {
			where += ' AND te.task_id = ?'
			params.push(Number(req.query.task_id))
		}
		if (req.query.project_id) {
			where += ' AND te.project_id = ?'
			params.push(Number(req.query.project_id))
		}
		if (String(req.query.running ?? '') === 'true') {
			where += ' AND te.end_time IS NULL'
		}

		const rows = await query(
			`SELECT te.*, t.title AS task_title FROM time_entries te
			 LEFT JOIN tasks t ON t.id = te.task_id
			 WHERE ${where} ORDER BY te.start_time DESC LIMIT 500`,
			params,
		)
		return res.json(rows.map(r => ({...shapeEntry(r), task_title: r.task_title ?? ''})))
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/time-entries', requireRealUser, async (req, res, next) => {
	try {
		const taskId = Number(req.body?.task_id) || 0
		let projectId = Number(req.body?.project_id) || 0

		if (taskId) {
			const task = await one('SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId])
			if (!task) {
				return res.status(404).json({message: 'task not found'})
			}
			projectId = task.project_id
		}
		if (!projectId) {
			return res.status(400).json({message: 'a task_id or project_id is required'})
		}
		// Logging time against something you cannot see would leak that it exists.
		if (!(await canReadProject(req.user.id, projectId))) {
			return res.status(403).json({message: 'forbidden'})
		}

		// A second running timer would make "stop the timer" ambiguous.
		const running = await one(
			'SELECT id FROM time_entries WHERE user_id = ? AND end_time IS NULL', [req.user.id])
		const endTime = req.body?.end_time ? new Date(req.body.end_time) : null
		if (!endTime && running) {
			return res.status(409).json({message: 'a timer is already running'})
		}

		const startTime = req.body?.start_time ? new Date(req.body.start_time) : new Date()
		if (endTime && endTime < startTime) {
			return res.status(400).json({message: 'the end time cannot be before the start time'})
		}

		const result = await query(
			`INSERT INTO time_entries (user_id, task_id, project_id, start_time, end_time, comment, created, updated)
			 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[req.user.id, taskId || null, projectId, startTime, endTime, String(req.body?.comment ?? '')],
		)

		const row = await one('SELECT * FROM time_entries WHERE id = ?', [result.insertId])
		return res.status(201).json(shapeEntry(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/time-entries/timer/stop', requireRealUser, async (req, res, next) => {
	try {
		const running = await one(
			'SELECT * FROM time_entries WHERE user_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1',
			[req.user.id],
		)
		if (!running) {
			return res.status(404).json({message: 'no timer is running'})
		}

		await query('UPDATE time_entries SET end_time = UTC_TIMESTAMP(), updated = UTC_TIMESTAMP() WHERE id = ?',
			[running.id])

		const row = await one('SELECT * FROM time_entries WHERE id = ?', [running.id])
		return res.json(shapeEntry(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.put('/time-entries/:entry(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const entry = await one('SELECT * FROM time_entries WHERE id = ? AND user_id = ?',
			[Number(req.params.entry), req.user.id])
		if (!entry) {
			return res.status(404).json({message: 'time entry not found'})
		}

		const startTime = req.body?.start_time ? new Date(req.body.start_time) : entry.start_time
		const endTime = req.body?.end_time === null
			? null
			: (req.body?.end_time ? new Date(req.body.end_time) : entry.end_time)

		if (endTime && new Date(endTime) < new Date(startTime)) {
			return res.status(400).json({message: 'the end time cannot be before the start time'})
		}

		await query(
			'UPDATE time_entries SET start_time = ?, end_time = ?, comment = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
			[startTime, endTime, String(req.body?.comment ?? entry.comment ?? ''), entry.id],
		)

		const row = await one('SELECT * FROM time_entries WHERE id = ?', [entry.id])
		return res.json(shapeEntry(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.delete('/time-entries/:entry(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const result = await query('DELETE FROM time_entries WHERE id = ? AND user_id = ?',
			[Number(req.params.entry), req.user.id])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'time entry not found'})
		}
		return res.status(204).end()
	} catch (err) {
		return next(err)
	}
})

extras2Router.get(
	'/projects/:project(\\d+)/time-entries',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			// A project view of tracked time is only for people who administer it —
			// otherwise every member could read everyone else's hours.
			if (req.projectPermission < PERMISSION_ADMIN) {
				return res.status(403).json({message: 'only a project admin can see everyone\'s tracked time'})
			}

			const rows = await query(
				`SELECT te.*, u.username, t.title AS task_title FROM time_entries te
				 JOIN users u ON u.id = te.user_id
				 LEFT JOIN tasks t ON t.id = te.task_id
				 WHERE te.project_id = ? ORDER BY te.start_time DESC LIMIT 1000`,
				[req.projectId],
			)
			return res.json(rows.map(r => ({...shapeEntry(r), username: r.username, task_title: r.task_title ?? ''})))
		} catch (err) {
			return next(err)
		}
	},
)

extras2Router.get('/tasks/:task(\\d+)/time-entries', requireRealUser, async (req, res, next) => {
	try {
		const task = await one('SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL',
			[Number(req.params.task)])
		if (!task || !(await canReadProject(req.user.id, task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}

		const rows = await query(
			`SELECT te.*, u.username FROM time_entries te JOIN users u ON u.id = te.user_id
			 WHERE te.task_id = ? ORDER BY te.start_time DESC`,
			[Number(req.params.task)],
		)
		return res.json(rows.map(r => ({...shapeEntry(r), username: r.username})))
	} catch (err) {
		return next(err)
	}
})

// --- notifications -----------------------------------------------------

extras2Router.post('/notifications/:id(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		// Scoped to the caller so one user cannot mark another's notifications read.
		const result = await query(
			`UPDATE notifications SET read_at = ${req.body?.read === false ? 'NULL' : 'UTC_TIMESTAMP()'}
			 WHERE id = ? AND notifiable_id = ?`,
			[Number(req.params.id), req.user.id],
		)
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'notification not found'})
		}
		return res.json({message: 'ok'})
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/notifications', requireRealUser, async (req, res, next) => {
	try {
		await query('UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE notifiable_id = ? AND read_at IS NULL',
			[req.user.id])
		return res.json({message: 'all notifications marked as read'})
	} catch (err) {
		return next(err)
	}
})

// --- task duplicate ----------------------------------------------------

extras2Router.put('/tasks/:task(\\d+)/duplicate', requireRealUser, async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const task = await one('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId])
		if (!task) {
			return res.status(404).json({message: 'task not found'})
		}

		const targetProject = Number(req.body?.project_id) || task.project_id
		if (!(await canWriteProject(req.user.id, targetProject))) {
			return res.status(403).json({message: 'forbidden'})
		}

		const maxRow = await one('SELECT COALESCE(MAX(`index`), 0) AS n FROM tasks WHERE project_id = ?',
			[targetProject])
		const index = Number(maxRow.n) + 1

		const result = await query(
			`INSERT INTO tasks (title, description, project_id, done, priority, due_date, start_date,
			                    end_date, percent_done, hex_color, repeat_after, repeat_mode,
			                    \`index\`, created_by_id, created, updated)
			 SELECT CONCAT(title, ' (copy)'), description, ?, 0, priority, due_date, start_date,
			        end_date, percent_done, hex_color, repeat_after, repeat_mode,
			        ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()
			 FROM tasks WHERE id = ?`,
			[targetProject, index, req.user.id, taskId],
		)
		const newId = result.insertId

		// Labels and assignees come along; comments and attachments deliberately do
		// not — they belong to the conversation on the original task.
		await query('INSERT IGNORE INTO label_tasks (task_id, label_id, created) SELECT ?, label_id, UTC_TIMESTAMP() FROM label_tasks WHERE task_id = ?',
			[newId, taskId])
		if (targetProject === task.project_id) {
			await query('INSERT IGNORE INTO task_assignees (task_id, user_id, created) SELECT ?, user_id, UTC_TIMESTAMP() FROM task_assignees WHERE task_id = ?',
				[newId, taskId])
		}
		await query('INSERT INTO task_reminders (task_id, reminder, relative_period, relative_to, created) SELECT ?, reminder, relative_period, relative_to, UTC_TIMESTAMP() FROM task_reminders WHERE task_id = ?',
			[newId, taskId])

		await addTaskToViews(newId, targetProject, index, false)

		const row = await one('SELECT * FROM tasks WHERE id = ?', [newId])
		return res.status(201).json(shapeTask(row))
	} catch (err) {
		return next(err)
	}
})

// --- project user search ----------------------------------------------

extras2Router.get(
	'/projects/:project(\\d+)/projectusers',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const search = String(req.query.s ?? '').trim()
			const params = [req.projectId, req.projectId, req.projectId]
			let extra = ''
			if (search) {
				extra = ' AND (u.username LIKE ? OR u.name LIKE ?)'
				params.push(`%${search}%`, `%${search}%`)
			}

			// Everyone who can reach the project: owner, direct shares, team shares.
			// This backs the assignee picker, so it must not list the whole instance.
			const rows = await query(
				`SELECT DISTINCT u.id, u.username, u.name, u.email, u.created, u.updated
				 FROM users u
				 WHERE (u.id = (SELECT owner_id FROM projects WHERE id = ?)
				     OR u.id IN (SELECT user_id FROM users_projects WHERE project_id = ?)
				     OR u.id IN (SELECT tm.user_id FROM team_members tm
				                 JOIN team_projects tp ON tp.team_id = tm.team_id
				                 WHERE tp.project_id = ?))${extra}
				 ORDER BY u.username LIMIT 50`,
				params,
			)
			return res.json(rows.map(shapeUser))
		} catch (err) {
			return next(err)
		}
	},
)

// --- project background ------------------------------------------------

const backgroundUpload = multer({
	storage: multer.memoryStorage(),
	limits: {fileSize: 20 * 1024 * 1024},
})

extras2Router.put(
	'/projects/:project(\\d+)/backgrounds/upload',
	requireProject(PERMISSION_ADMIN),
	backgroundUpload.any(),
	async (req, res, next) => {
		try {
			const file = req.file ?? (req.files ?? [])[0]
			if (!file) {
				return res.status(400).json({message: 'no image was uploaded'})
			}

			const mime = sniffMime(file.buffer)
			if (!mime.startsWith('image/')) {
				return res.status(415).json({message: 'that file is not an image'})
			}

			const fsp = (await import('node:fs/promises')).default
			const path = (await import('node:path')).default
			await fsp.mkdir(config.filesPath, {recursive: true})

			const inserted = await query(
				'INSERT INTO files (name, mime, size, created_by_id, created) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
				[file.originalname, mime, file.size, req.user.id],
			)
			await fsp.writeFile(path.join(config.filesPath, String(inserted.insertId)), file.buffer)

			const previous = await one('SELECT background_file_id FROM projects WHERE id = ?', [req.projectId])
				.catch(() => null)

			await query(
				'UPDATE projects SET background_file_id = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
				[inserted.insertId, req.projectId],
			)

			if (previous?.background_file_id) {
				await query('DELETE FROM files WHERE id = ?', [previous.background_file_id]).catch(() => {})
				await fsp.rm(path.join(config.filesPath, String(previous.background_file_id)), {force: true}).catch(() => {})
			}

			const row = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			return res.json({...row, is_archived: Boolean(row.is_archived)})
		} catch (err) {
			return next(err)
		}
	},
)

extras2Router.get(
	'/projects/:project(\\d+)/background',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const project = await one('SELECT background_file_id FROM projects WHERE id = ?', [req.projectId])
				.catch(() => null)
			if (!project?.background_file_id) {
				return res.status(404).json({message: 'this project has no background'})
			}

			const file = await one('SELECT id, name, mime FROM files WHERE id = ?', [project.background_file_id])
			if (!file) {
				return res.status(404).json({message: 'background file missing'})
			}

			const path = (await import('node:path')).default
			const fs = (await import('node:fs')).default
			const blob = path.join(config.filesPath, String(file.id))
			if (!fs.existsSync(blob)) {
				return res.status(404).json({message: 'background file missing from storage'})
			}

			// The mime was derived from the bytes at upload time, so serving it
			// inline cannot be turned into markup.
			res.setHeader('Content-Type', file.mime)
			res.setHeader('X-Content-Type-Options', 'nosniff')
			res.setHeader('Cache-Control', 'private, max-age=3600')
			return res.sendFile(path.resolve(blob))
		} catch (err) {
			return next(err)
		}
	},
)

extras2Router.delete(
	'/projects/:project(\\d+)/background',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const project = await one('SELECT background_file_id FROM projects WHERE id = ?', [req.projectId])
				.catch(() => null)

			await query(
				'UPDATE projects SET background_file_id = NULL, updated = UTC_TIMESTAMP() WHERE id = ?',
				[req.projectId],
			)

			if (project?.background_file_id) {
				const fsp = (await import('node:fs/promises')).default
				const path = (await import('node:path')).default
				await query('DELETE FROM files WHERE id = ?', [project.background_file_id]).catch(() => {})
				await fsp.rm(path.join(config.filesPath, String(project.background_file_id)), {force: true}).catch(() => {})
			}

			return res.json({message: 'background removed'})
		} catch (err) {
			return next(err)
		}
	},
)

// --- bulk task operations ----------------------------------------------

extras2Router.post('/tasks/:task(\\d+)/assignees/bulk', requireRealUser, async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const task = await one('SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId])
		if (!task || !(await canWriteProject(req.user.id, task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}

		const assignees = Array.isArray(req.body?.assignees) ? req.body.assignees : []
		const ids = []
		for (const a of assignees) {
			const user = typeof a === 'object'
				? await one('SELECT id FROM users WHERE id = ? OR username = ?', [Number(a.id) || 0, String(a.username ?? '')])
				: await one('SELECT id FROM users WHERE id = ? OR username = ?', [Number(a) || 0, String(a)])
			// Someone who cannot open the project would be assigned invisibly.
			if (user && await canReadProject(user.id, task.project_id)) {
				ids.push(user.id)
			}
		}

		// The client sends the whole set, so this replaces rather than appends.
		await query('DELETE FROM task_assignees WHERE task_id = ?', [taskId])
		for (const id of ids) {
			await query('INSERT INTO task_assignees (task_id, user_id, created) VALUES (?, ?, UTC_TIMESTAMP())',
				[taskId, id])
		}

		return res.json({assignees: ids})
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/tasks/:task(\\d+)/labels/bulk', requireRealUser, async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const task = await one('SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId])
		if (!task || !(await canWriteProject(req.user.id, task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}

		const labels = Array.isArray(req.body?.labels) ? req.body.labels : []
		const ids = labels.map(l => Number(typeof l === 'object' ? l.id : l)).filter(Number.isInteger)

		await query('DELETE FROM label_tasks WHERE task_id = ?', [taskId])
		for (const id of ids) {
			await query('INSERT IGNORE INTO label_tasks (task_id, label_id, created) VALUES (?, ?, UTC_TIMESTAMP())',
				[taskId, id])
		}

		return res.json({labels: ids})
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/tasks/:task(\\d+)/read', requireRealUser, async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const task = await one('SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL', [taskId])
		if (!task || !(await canReadProject(req.user.id, task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}

		await query('DELETE FROM task_unread_statuses WHERE task_id = ? AND user_id = ?', [taskId, req.user.id])
		return res.json({message: 'marked as read'})
	} catch (err) {
		return next(err)
	}
})

extras2Router.get(
	'/projects/:project(\\d+)/tasks/by-index/:index(\\d+)',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const row = await one(
				'SELECT * FROM tasks WHERE project_id = ? AND `index` = ? AND deleted_at IS NULL',
				[req.projectId, Number(req.params.index)],
			)
			if (!row) {
				return res.status(404).json({message: 'task not found'})
			}
			return res.json(shapeTask(row))
		} catch (err) {
			return next(err)
		}
	},
)

// --- label update ------------------------------------------------------

extras2Router.post('/labels/:label(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const label = await one('SELECT * FROM labels WHERE id = ?', [Number(req.params.label)])
		if (!label) {
			return res.status(404).json({message: 'label not found'})
		}
		// Labels are shared across everyone's tasks, so only the creator may edit.
		if (label.created_by_id !== req.user.id) {
			return res.status(403).json({message: 'forbidden'})
		}

		const sets = []
		const params = []
		if (req.body?.title !== undefined) {
			const title = String(req.body.title).trim()
			if (!title) {
				return res.status(400).json({message: 'a title is required'})
			}
			sets.push('title = ?')
			params.push(title.slice(0, 250))
		}
		if (req.body?.description !== undefined) {
			sets.push('description = ?')
			params.push(String(req.body.description))
		}
		if (req.body?.hex_color !== undefined) {
			const hex = String(req.body.hex_color).replace(/^#/, '')
			sets.push('hex_color = ?')
			params.push(/^[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '')
		}

		if (sets.length > 0) {
			sets.push('updated = UTC_TIMESTAMP()')
			await query(`UPDATE labels SET ${sets.join(', ')} WHERE id = ?`, [...params, label.id])
		}

		const row = await one('SELECT * FROM labels WHERE id = ?', [label.id])
		return res.json(row)
	} catch (err) {
		return next(err)
	}
})

// --- bot accounts ------------------------------------------------------

/**
 * A bot is a user row owned by another user, used for API access rather than
 * logging in. It has no password, so `login` can never authenticate one — the
 * only way to act as a bot is an API token its owner created.
 */
function shapeBot(row) {
	return {
		id: row.id,
		username: row.username,
		name: row.name ?? '',
		bot_owner_id: row.bot_owner_id,
		created: row.created,
		updated: row.updated,
	}
}

extras2Router.get('/user/bots', requireRealUser, async (req, res, next) => {
	try {
		const rows = await query(
			'SELECT id, username, name, bot_owner_id, created, updated FROM users WHERE bot_owner_id = ? ORDER BY id',
			[req.user.id],
		)
		return res.json(rows.map(shapeBot))
	} catch (err) {
		return next(err)
	}
})

extras2Router.get('/user/bots/:bot(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const row = await one(
			'SELECT id, username, name, bot_owner_id, created, updated FROM users WHERE id = ? AND bot_owner_id = ?',
			[Number(req.params.bot), req.user.id],
		)
		if (!row) {
			return res.status(404).json({message: 'bot not found'})
		}
		return res.json(shapeBot(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.put('/user/bots', requireRealUser, async (req, res, next) => {
	try {
		const username = String(req.body?.username ?? '').trim()
		if (!username || /\s/.test(username)) {
			return res.status(400).json({message: 'a username is required and cannot contain spaces'})
		}

		const clash = await one('SELECT id FROM users WHERE username = ?', [username])
		if (clash) {
			return res.status(409).json({message: 'that username is already taken'})
		}

		// No password and no email: a bot is not something anyone logs into, and
		// leaving those unset means a stolen row cannot become a usable account.
		const result = await query(
			`INSERT INTO users (username, password, email, name, status, is_admin, bot_owner_id, created, updated)
			 VALUES (?, '', '', ?, 0, 0, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[username.slice(0, 250), String(req.body?.name ?? ''), req.user.id],
		)

		const row = await one('SELECT * FROM users WHERE id = ?', [result.insertId])
		return res.status(201).json(shapeBot(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.post('/user/bots/:bot(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const bot = await one('SELECT id FROM users WHERE id = ? AND bot_owner_id = ?',
			[Number(req.params.bot), req.user.id])
		if (!bot) {
			return res.status(404).json({message: 'bot not found'})
		}

		if (req.body?.name !== undefined) {
			await query('UPDATE users SET name = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
				[String(req.body.name), bot.id])
		}

		const row = await one('SELECT * FROM users WHERE id = ?', [bot.id])
		return res.json(shapeBot(row))
	} catch (err) {
		return next(err)
	}
})

extras2Router.delete('/user/bots/:bot(\\d+)', requireRealUser, async (req, res, next) => {
	try {
		const bot = await one('SELECT id FROM users WHERE id = ? AND bot_owner_id = ?',
			[Number(req.params.bot), req.user.id])
		if (!bot) {
			return res.status(404).json({message: 'bot not found'})
		}

		// Its tokens are what actually grant access, so they go first.
		await query('DELETE FROM api_tokens WHERE owner_id = ?', [bot.id])
		const {deleteUserAccount} = await import('./account.js')
		await deleteUserAccount(bot.id)

		return res.json({message: 'bot deleted'})
	} catch (err) {
		return next(err)
	}
})
