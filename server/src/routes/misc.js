import express from 'express'

import {requireAuth} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {PERMISSION_READ, PERMISSION_WRITE, requireProject} from '../lib/permissions.js'
import {shapeLabel} from '../lib/shape.js'

export const miscRouter = express.Router()
miscRouter.use(requireAuth)

// --- labels ------------------------------------------------------------

miscRouter.get('/labels', async (req, res, next) => {
	try {
		// Labels the caller created, plus any already attached to a task they can
		// see — matching what the label picker needs to offer.
		const rows = await query(
			`SELECT DISTINCT l.* FROM labels l
			 LEFT JOIN label_tasks lt ON lt.label_id = l.id
			 LEFT JOIN tasks t ON t.id = lt.task_id
			 LEFT JOIN projects p ON p.id = t.project_id
			 WHERE l.created_by_id = ?
			    OR p.owner_id = ?
			    OR EXISTS (SELECT 1 FROM users_projects up WHERE up.project_id = p.id AND up.user_id = ?)
			    OR EXISTS (SELECT 1 FROM team_projects tp
			               JOIN team_members tm ON tm.team_id = tp.team_id
			               WHERE tp.project_id = p.id AND tm.user_id = ?)
			 ORDER BY l.title`,
			[req.user.id, req.user.id, req.user.id, req.user.id],
		)
		return res.json(rows.map(shapeLabel))
	} catch (err) {
		return next(err)
	}
})

miscRouter.put('/labels', async (req, res, next) => {
	try {
		const title = String(req.body?.title ?? '').trim()
		if (!title) {
			return res.status(400).json({message: 'a title is required'})
		}
		const result = await query(
			`INSERT INTO labels (title, description, hex_color, created_by_id, created, updated)
			 VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[title, req.body?.description ?? '', req.body?.hex_color ?? '', req.user.id],
		)
		const row = await one('SELECT * FROM labels WHERE id = ?', [result.insertId])
		return res.status(201).json(shapeLabel(row))
	} catch (err) {
		return next(err)
	}
})

miscRouter.delete('/labels/:label', async (req, res, next) => {
	try {
		const label = await one('SELECT * FROM labels WHERE id = ?', [Number(req.params.label)])
		if (!label) {
			return res.status(404).json({message: 'label not found'})
		}
		// Only the creator may delete: labels are shared across everyone's tasks.
		if (label.created_by_id !== req.user.id) {
			return res.status(403).json({message: 'forbidden'})
		}
		await query('DELETE FROM label_tasks WHERE label_id = ?', [label.id])
		await query('DELETE FROM labels WHERE id = ?', [label.id])
		return res.json({message: 'label deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- kanban buckets ----------------------------------------------------

miscRouter.get(
	'/projects/:project/views/:view/buckets',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const view = await one('SELECT id FROM project_views WHERE id = ? AND project_id = ?',
				[viewId, req.projectId])
			if (!view) {
				return res.status(404).json({message: 'view not found'})
			}

			const buckets = await query(
				'SELECT id, title, project_view_id, `limit`, position, created, updated FROM buckets WHERE project_view_id = ? ORDER BY position, id',
				[viewId],
			)

			// The board renders bucket -> tasks, so send the tasks with them.
			for (const b of buckets) {
				const rows = await query(
					`SELECT t.* FROM task_buckets tb JOIN tasks t ON t.id = tb.task_id
					 WHERE tb.bucket_id = ? AND t.deleted_at IS NULL
					 ORDER BY t.\`index\``,
					[b.id],
				)
				const {shapeTasks} = await import('../lib/shape.js')
				b.tasks = await shapeTasks(rows)
				b.count = rows.length
			}

			return res.json(buckets)
		} catch (err) {
			return next(err)
		}
	},
)

miscRouter.put(
	'/projects/:project/views/:view/buckets',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const title = String(req.body?.title ?? '').trim()
			if (!title) {
				return res.status(400).json({message: 'a title is required'})
			}

			const viewId = Number(req.params.view)
			const maxRow = await one(
				'SELECT COALESCE(MAX(position), 0) AS pos FROM buckets WHERE project_view_id = ?',
				[viewId],
			)
			const result = await query(
				`INSERT INTO buckets (title, project_view_id, \`limit\`, position, created_by_id, created, updated)
				 VALUES (?, ?, 0, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[title, viewId, Number(maxRow.pos) + 100, req.user.id],
			)
			const row = await one('SELECT * FROM buckets WHERE id = ?', [result.insertId])
			return res.status(201).json({...row, tasks: [], count: 0})
		} catch (err) {
			return next(err)
		}
	},
)

// Moving a card between columns.
miscRouter.post(
	'/projects/:project/views/:view/buckets/:bucket/tasks',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const bucketId = Number(req.params.bucket)
			const taskId = Number(req.body?.task_id)
			if (!Number.isInteger(taskId)) {
				return res.status(400).json({message: 'task_id is required'})
			}

			// Scope the task to this project so a card cannot be moved in from one
			// the caller only has read access to.
			const task = await one('SELECT id FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL',
				[taskId, req.projectId])
			if (!task) {
				return res.status(404).json({message: 'task not found in this project'})
			}

			await query('DELETE FROM task_buckets WHERE task_id = ? AND project_view_id = ?', [taskId, viewId])
			await query('INSERT INTO task_buckets (bucket_id, task_id, project_view_id) VALUES (?, ?, ?)',
				[bucketId, taskId, viewId])

			return res.json({task_id: taskId, bucket_id: bucketId})
		} catch (err) {
			return next(err)
		}
	},
)

// --- notifications -----------------------------------------------------

miscRouter.get('/notifications', async (req, res, next) => {
	try {
		const rows = await query(
			`SELECT id, notifiable_id, notification, name, read_at, created
			 FROM notifications WHERE notifiable_id = ? ORDER BY created DESC LIMIT 50`,
			[req.user.id],
		)
		return res.json(rows.map(r => ({
			id: r.id,
			name: r.name,
			notification: (() => {
				try {
					return JSON.parse(r.notification)
				} catch {
					return {}
				}
			})(),
			read_at: r.read_at,
			created: r.created,
		})))
	} catch (err) {
		return next(err)
	}
})

// --- saved filters -----------------------------------------------------

miscRouter.get('/filters', async (req, res, next) => {
	try {
		const rows = await query(
			'SELECT id, title, description, filters, owner_id, created, updated FROM saved_filters WHERE owner_id = ? ORDER BY title',
			[req.user.id],
		)
		return res.json(rows)
	} catch (err) {
		return next(err)
	}
})

// --- user settings -----------------------------------------------------

miscRouter.post('/user/settings/general', async (req, res, next) => {
	try {
		const {name} = req.body ?? {}
		if (name !== undefined) {
			await query('UPDATE users SET name = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
				[String(name), req.user.id])
		}
		return res.json({message: 'settings updated'})
	} catch (err) {
		return next(err)
	}
})

// --- endpoints the client calls that have no data model here -----------

/**
 * Avatars. The client requests one per user in every list; a 404 leaves broken
 * images and noisy console errors, so serve a deterministic initials tile.
 */
miscRouter.get('/avatar/:username', async (req, res, next) => {
	try {
		const name = String(req.params.username ?? '?')
		const initial = [...name][0]?.toUpperCase() ?? '?'

		// Stable colour per name so a user looks the same everywhere.
		let hash = 0
		for (const ch of name) {
			hash = (hash * 31 + ch.codePointAt(0)) % 360
		}

		const size = Math.min(512, Math.max(16, Number(req.query.size ?? 64)))
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
			`<rect width="64" height="64" fill="hsl(${hash},55%,45%)"/>` +
			`<text x="32" y="43" font-family="sans-serif" font-size="32" font-weight="600" ` +
			`fill="#fff" text-anchor="middle">${initial}</text></svg>`

		res.setHeader('Content-Type', 'image/svg+xml')
		res.setHeader('Cache-Control', 'public, max-age=86400')
		return res.send(svg)
	} catch (err) {
		return next(err)
	}
})
