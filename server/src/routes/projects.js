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

const VIEW_KINDS = ['list', 'gantt', 'table', 'kanban', 'storage']

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

/**
 * Loads views for many projects at once, keyed by project id. The client renders
 * a project's tab bar straight from project.views, so a project without them
 * shows no tabs at all.
 */
async function viewsByProject(projectIds) {
	const byProject = new Map()
	if (projectIds.length === 0) {
		return byProject
	}
	const ph = projectIds.map(() => '?').join(',')
	const rows = await query(
		`SELECT * FROM project_views WHERE project_id IN (${ph}) ORDER BY position, id`,
		projectIds,
	)
	for (const r of rows) {
		if (!byProject.has(r.project_id)) {
			byProject.set(r.project_id, [])
		}
		byProject.get(r.project_id).push(shapeView(r))
	}
	return byProject
}

function shapeProject(row, maxPermission, views = []) {
	return {
		views,
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

		const views = await viewsByProject(rows.map(r => r.id))
		return res.json(rows.map(r => shapeProject(r, undefined, views.get(r.id) ?? [])))
	} catch (err) {
		return next(err)
	}
})

projectsRouter.get(
	'/projects/:project(\\d+)',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const row = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			if (!row) {
				return res.status(404).json({message: 'project not found'})
			}
			const views = await viewsByProject([row.id])
			return res.json(shapeProject(row, req.projectPermission, views.get(row.id) ?? []))
		} catch (err) {
			return next(err)
		}
	},
)

projectsRouter.get(
	'/projects/:project(\\d+)/views',
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

			return res.json(rows.map(shapeView))
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
	'/projects/:project(\\d+)',
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
	'/projects/:project(\\d+)',
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
