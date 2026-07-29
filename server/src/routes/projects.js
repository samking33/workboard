import express from 'express'

import {requireAuth} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {
	PERMISSION_ADMIN,
	PERMISSION_READ,
	PERMISSION_WRITE,
	requireProject,
	visibleProjectIds,
} from '../lib/permissions.js'

export const projectsRouter = express.Router()

projectsRouter.use(requireAuth)

function shapeProject(row, maxPermission) {
	return {
		id: row.id,
		title: row.title,
		description: row.description ?? '',
		identifier: row.identifier ?? '',
		hex_color: row.hex_color ?? '',
		owner_id: row.owner_id,
		parent_project_id: row.parent_project_id ?? 0,
		is_archived: Boolean(row.is_archived),
		position: row.position,
		created: row.created,
		updated: row.updated,
		max_permission: maxPermission ?? null,
	}
}

projectsRouter.get('/projects', async (req, res, next) => {
	try {
		const ids = await visibleProjectIds(req.user.id)
		if (ids.length === 0) {
			return res.json([])
		}

		// Built from ids resolved server-side, never from user input.
		const placeholders = ids.map(() => '?').join(',')
		const rows = await query(
			`SELECT * FROM projects WHERE id IN (${placeholders}) AND is_archived = 0
			 ORDER BY position, id`,
			ids,
		)

		return res.json(rows.map(r => shapeProject(r)))
	} catch (err) {
		return next(err)
	}
})

projectsRouter.get(
	'/projects/:project',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const row = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			if (!row) {
				return res.status(404).json({message: 'project not found'})
			}
			return res.json(shapeProject(row, req.projectPermission))
		} catch (err) {
			return next(err)
		}
	},
)

projectsRouter.get(
	'/projects/:project/views',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const rows = await query(
				`SELECT id, title, project_id, view_kind, filter, position,
				        bucket_configuration_mode, default_bucket_id, done_bucket_id,
				        created, updated
				 FROM project_views WHERE project_id = ? ORDER BY position, id`,
				[req.projectId],
			)

			// view_kind is stored as an int; the client works in strings.
			const kinds = ['list', 'gantt', 'table', 'kanban', 'storage']
			return res.json(rows.map(r => ({...r, view_kind: kinds[r.view_kind] ?? 'list'})))
		} catch (err) {
			return next(err)
		}
	},
)

projectsRouter.put('/projects', async (req, res, next) => {
	try {
		const {title, description = '', parent_project_id: parentId = 0} = req.body ?? {}
		if (!title || !String(title).trim()) {
			return res.status(400).json({message: 'a title is required'})
		}

		const result = await query(
			`INSERT INTO projects (title, description, owner_id, parent_project_id,
			                       is_archived, position, created, updated)
			 VALUES (?, ?, ?, ?, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[String(title).trim(), description, req.user.id, parentId || null],
		)

		const row = await one('SELECT * FROM projects WHERE id = ?', [result.insertId])
		return res.status(201).json(shapeProject(row, PERMISSION_ADMIN))
	} catch (err) {
		return next(err)
	}
})

projectsRouter.post(
	'/projects/:project',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const {title, description} = req.body ?? {}
			if (title !== undefined && !String(title).trim()) {
				return res.status(400).json({message: 'a title is required'})
			}

			await query(
				`UPDATE projects SET
					title = COALESCE(?, title),
					description = COALESCE(?, description),
					updated = UTC_TIMESTAMP()
				 WHERE id = ?`,
				[title ?? null, description ?? null, req.projectId],
			)

			const row = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			return res.json(shapeProject(row, req.projectPermission))
		} catch (err) {
			return next(err)
		}
	},
)

projectsRouter.delete(
	'/projects/:project',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			await query('DELETE FROM projects WHERE id = ?', [req.projectId])
			return res.json({message: 'project deleted'})
		} catch (err) {
			return next(err)
		}
	},
)
