import express from 'express'

import {requireAuth} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {PERMISSION_READ, PERMISSION_WRITE, requireProject} from '../lib/permissions.js'
import {bucketsWithTasks} from '../lib/board.js'
import {rollRepeatingTask} from '../lib/repeat.js'
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

miscRouter.delete('/labels/:label(\\d+)', async (req, res, next) => {
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
	'/projects/:project(\\d+)/views/:view(\\d+)/buckets',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const view = await one('SELECT id FROM project_views WHERE id = ? AND project_id = ?',
				[viewId, req.projectId])
			if (!view) {
				return res.status(404).json({message: 'view not found'})
			}

			return res.json(await bucketsWithTasks(viewId))
		} catch (err) {
			return next(err)
		}
	},
)

miscRouter.put(
	'/projects/:project(\\d+)/views/:view(\\d+)/buckets',
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

// Renaming a column or setting its WIP limit.
miscRouter.post(
	'/projects/:project(\\d+)/views/:view(\\d+)/buckets/:bucket(\\d+)',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const bucket = await one(
				`SELECT b.* FROM buckets b JOIN project_views v ON v.id = b.project_view_id
				 WHERE b.id = ? AND b.project_view_id = ? AND v.project_id = ?`,
				[Number(req.params.bucket), Number(req.params.view), req.projectId],
			)
			if (!bucket) {
				return res.status(404).json({message: 'bucket not found'})
			}

			const sets = []
			const params = []
			if (req.body?.title !== undefined) {
				const title = String(req.body.title).trim()
				if (!title) {
					return res.status(400).json({message: 'a title is required'})
				}
				sets.push('title = ?')
				params.push(title)
			}
			if (req.body?.limit !== undefined) {
				const limit = Number(req.body.limit)
				if (!Number.isInteger(limit) || limit < 0) {
					return res.status(400).json({message: 'limit must be zero or a positive whole number'})
				}
				sets.push('`limit` = ?')
				params.push(limit)
			}
			if (req.body?.position !== undefined && Number.isFinite(Number(req.body.position))) {
				sets.push('position = ?')
				params.push(Number(req.body.position))
			}

			if (sets.length > 0) {
				sets.push('updated = UTC_TIMESTAMP()')
				await query(`UPDATE buckets SET ${sets.join(', ')} WHERE id = ?`, [...params, bucket.id])
			}

			const row = await one('SELECT * FROM buckets WHERE id = ?', [bucket.id])
			return res.json(row)
		} catch (err) {
			return next(err)
		}
	},
)

miscRouter.delete(
	'/projects/:project(\\d+)/views/:view(\\d+)/buckets/:bucket(\\d+)',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const bucketId = Number(req.params.bucket)

			const bucket = await one(
				`SELECT b.* FROM buckets b JOIN project_views v ON v.id = b.project_view_id
				 WHERE b.id = ? AND b.project_view_id = ? AND v.project_id = ?`,
				[bucketId, viewId, req.projectId],
			)
			if (!bucket) {
				return res.status(404).json({message: 'bucket not found'})
			}

			const remaining = await query(
				'SELECT id FROM buckets WHERE project_view_id = ? AND id <> ? ORDER BY position, id LIMIT 1',
				[viewId, bucketId],
			)
			if (remaining.length === 0) {
				return res.status(400).json({message: 'a board needs at least one bucket'})
			}

			// Cards move to the leftmost remaining column rather than vanishing with
			// the bucket — deleting a column should not look like deleting its tasks.
			await query('UPDATE task_buckets SET bucket_id = ? WHERE bucket_id = ? AND project_view_id = ?',
				[remaining[0].id, bucketId, viewId])
			await query('DELETE FROM buckets WHERE id = ?', [bucketId])

			return res.json({message: 'bucket deleted'})
		} catch (err) {
			return next(err)
		}
	},
)

// Moving a card between columns.
miscRouter.post(
	'/projects/:project(\\d+)/views/:view(\\d+)/buckets/:bucket(\\d+)/tasks',
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

			const bucket = await one(
				`SELECT b.id, b.\`limit\` FROM buckets b JOIN project_views v ON v.id = b.project_view_id
				 WHERE b.id = ? AND b.project_view_id = ? AND v.project_id = ?`,
				[bucketId, viewId, req.projectId],
			)
			if (!bucket) {
				return res.status(404).json({message: 'bucket not found'})
			}

			// A WIP limit only bites when the card is arriving from elsewhere;
			// reordering within a full column has to stay possible.
			if (bucket.limit > 0) {
				const current = await one(
					`SELECT COUNT(*) AS n FROM task_buckets tb JOIN tasks t ON t.id = tb.task_id
					 WHERE tb.bucket_id = ? AND tb.project_view_id = ? AND tb.task_id <> ? AND t.deleted_at IS NULL`,
					[bucketId, viewId, taskId],
				)
				if (Number(current.n) >= bucket.limit) {
					return res.status(412).json({message: 'this bucket is already at its limit'})
				}
			}

			await query(
				`INSERT INTO task_buckets (bucket_id, task_id, project_view_id) VALUES (?, ?, ?)
				 ON DUPLICATE KEY UPDATE bucket_id = VALUES(bucket_id)`,
				[bucketId, taskId, viewId],
			)

			// Dragging a card into the done column is how most people complete a task
			// on a board, so it has to set done — and dragging it back out clears it.
			const view = await one('SELECT done_bucket_id FROM project_views WHERE id = ?', [viewId])
			if (view?.done_bucket_id) {
				const nowDone = view.done_bucket_id === bucketId
				await query(
					`UPDATE tasks SET done = ?, done_at = ${nowDone ? 'UTC_TIMESTAMP()' : 'NULL'},
					 updated = UTC_TIMESTAMP() WHERE id = ? AND done <> ?`,
					[nowDone ? 1 : 0, taskId, nowDone ? 1 : 0],
				)
				if (nowDone) {
					await rollRepeatingTask(taskId)
				}
			}

			return res.json({task_id: taskId, bucket_id: bucketId, project_view_id: viewId})
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
