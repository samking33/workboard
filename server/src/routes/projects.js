import fsp from 'node:fs/promises'
import path from 'node:path'

import express from 'express'

import {requireAuth} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query, transaction} from '../lib/db.js'
import {dispatchWebhook} from '../lib/webhooks.js'
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

/** Stored without the leading #, and only if it is really a hex colour. */
function normaliseColor(value) {
	const hex = String(value ?? '').trim().replace(/^#/, '')
	return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : ''
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

// Storage leads at 50 — finding a project's material is the first thing this
// instance is for. The rest keep the upstream order.
const DEFAULT_VIEWS = [
	{title: 'Storage', kind: 4, position: 50},
	{title: 'List', kind: 0, position: 100, filter: 'done = false'},
	{title: 'Gantt', kind: 1, position: 200},
	{title: 'Table', kind: 2, position: 300},
	{title: 'Kanban', kind: 3, position: 400},
]

const DEFAULT_BUCKETS = [
	{title: 'To-Do', position: 100},
	{title: 'Doing', position: 200},
	{title: 'Done', position: 300},
]

/**
 * Without these a new project renders an empty tab bar — the client builds its
 * tabs straight from project.views.
 */
export async function createDefaultViews(projectId, userId) {
	for (const v of DEFAULT_VIEWS) {
		const result = await query(
			`INSERT INTO project_views (title, project_id, view_kind, filter, position,
			                            bucket_configuration_mode, created, updated)
			 VALUES (?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[v.title, projectId, v.kind, v.filter ?? null, v.position],
		)

		if (v.kind !== 3) {
			continue
		}

		const bucketIds = []
		for (const b of DEFAULT_BUCKETS) {
			const bucket = await query(
				`INSERT INTO buckets (title, project_view_id, \`limit\`, position, created_by_id, created, updated)
				 VALUES (?, ?, 0, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[b.title, result.insertId, b.position, userId],
			)
			bucketIds.push(bucket.insertId)
		}

		// Dropping a card in the done bucket is what marks a task done, so the
		// board is inert until the view knows which bucket that is.
		await query(
			'UPDATE project_views SET default_bucket_id = ?, done_bucket_id = ? WHERE id = ?',
			[bucketIds[0], bucketIds[bucketIds.length - 1], result.insertId],
		)
	}
}

projectsRouter.put('/projects', async (req, res, next) => {
	try {
		const {
			title,
			description = '',
			parent_project_id: parentId = 0,
			hex_color: hexColor = '',
			identifier = '',
		} = req.body ?? {}

		if (!title || !String(title).trim()) {
			return res.status(400).json({message: 'a title is required'})
		}

		// A parent the caller cannot write to would let them graft a project into
		// someone else's tree.
		if (parentId) {
			const {canWriteProject} = await import('../lib/permissions.js')
			if (!(await canWriteProject(req.user.id, Number(parentId)))) {
				return res.status(403).json({message: 'you cannot add a project under that parent'})
			}
		}

		const result = await query(
			`INSERT INTO projects (title, description, identifier, hex_color, owner_id,
			                       parent_project_id, is_archived, position, created, updated)
			 VALUES (?, ?, ?, ?, ?, ?, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[
				String(title).trim(), description,
				String(identifier).trim().slice(0, 10), normaliseColor(hexColor),
				req.user.id, parentId || null,
			],
		)

		await createDefaultViews(result.insertId, req.user.id)

		const row = await one('SELECT * FROM projects WHERE id = ?', [result.insertId])
		const views = await viewsByProject([row.id])
		const created = shapeProject(row, PERMISSION_ADMIN, views.get(row.id) ?? [])
		dispatchWebhook(row.id, 'project.created', {project: created}, req.user)
		return res.status(201).json(created)
	} catch (err) {
		return next(err)
	}
})

/** Walks up from the proposed parent; if we meet ourselves the tree would loop. */
async function createsCycle(projectId, parentId) {
	let cursor = parentId
	const seen = new Set()
	while (cursor) {
		if (cursor === projectId) {
			return true
		}
		if (seen.has(cursor)) {
			// Pre-existing loop in the data — stop rather than spin forever.
			return true
		}
		seen.add(cursor)
		const row = await one('SELECT parent_project_id FROM projects WHERE id = ?', [cursor])
		cursor = row?.parent_project_id ?? 0
	}
	return false
}

projectsRouter.post(
	'/projects/:project(\\d+)',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const body = req.body ?? {}
			if (body.title !== undefined && !String(body.title).trim()) {
				return res.status(400).json({message: 'a title is required'})
			}

			const sets = []
			const params = []
			const push = (sql, value) => {
				sets.push(sql)
				params.push(value)
			}

			if (body.title !== undefined) {
				push('title = ?', String(body.title).trim())
			}
			if (body.description !== undefined) {
				push('description = ?', body.description)
			}
			if (body.hex_color !== undefined) {
				push('hex_color = ?', normaliseColor(body.hex_color))
			}
			if (body.identifier !== undefined) {
				push('identifier = ?', String(body.identifier).trim().slice(0, 10))
			}
			if (body.is_archived !== undefined) {
				push('is_archived = ?', body.is_archived ? 1 : 0)
			}
			if (body.position !== undefined && Number.isFinite(Number(body.position))) {
				push('position = ?', Number(body.position))
			}

			if (body.parent_project_id !== undefined) {
				const parentId = Number(body.parent_project_id) || 0
				if (parentId === req.projectId) {
					return res.status(400).json({message: 'a project cannot be its own parent'})
				}
				if (parentId) {
					const {canWriteProject} = await import('../lib/permissions.js')
					if (!(await canWriteProject(req.user.id, parentId))) {
						return res.status(403).json({message: 'you cannot move this project under that parent'})
					}
					if (await createsCycle(req.projectId, parentId)) {
						return res.status(400).json({message: 'that would put the project inside itself'})
					}
				}
				push('parent_project_id = ?', parentId || null)
			}

			if (sets.length > 0) {
				sets.push('updated = UTC_TIMESTAMP()')
				await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, [...params, req.projectId])
			}

			const row = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			const views = await viewsByProject([row.id])
			return res.json(shapeProject(row, req.projectPermission, views.get(row.id) ?? []))
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
			// Nothing here cascades in the schema, so deleting only the project row
			// leaves its tasks, board and files behind as unreachable rows and
			// orphaned blobs on disk.
			const children = await query('SELECT id FROM projects WHERE parent_project_id = ?', [req.projectId])
			if (children.length > 0) {
				return res.status(400).json({
					message: `this project has ${children.length} sub-project(s); delete or move them first`,
				})
			}

			// Fired before the rows go, so the payload can still describe the project.
			const project = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			dispatchWebhook(req.projectId, 'project.deleted', {project: shapeProject(project)}, req.user)

			await deleteProjectCascade(req.projectId)
			return res.json({message: 'project deleted'})
		} catch (err) {
			return next(err)
		}
	},
)

export async function deleteProjectCascade(projectId) {
	const fileIds = []

	const storage = await query('SELECT file_id FROM storage_items WHERE project_id = ? AND file_id > 0', [projectId])
	fileIds.push(...storage.map(r => r.file_id))

	const attachments = await query(
		`SELECT ta.file_id FROM task_attachments ta JOIN tasks t ON t.id = ta.task_id
		 WHERE t.project_id = ?`,
		[projectId],
	)
	fileIds.push(...attachments.map(r => r.file_id))

	await transaction(async conn => {
		const [taskRows] = await conn.query('SELECT id FROM tasks WHERE project_id = ?', [projectId])
		const taskIds = taskRows.map(r => r.id)

		if (taskIds.length > 0) {
			const ph = taskIds.map(() => '?').join(',')
			for (const table of [
				'task_assignees', 'label_tasks', 'task_attachments', 'task_comments',
				'task_reminders', 'task_buckets', 'task_positions', 'task_unread_statuses',
			]) {
				await conn.query(`DELETE FROM ${table} WHERE task_id IN (${ph})`, taskIds)
			}
			await conn.query(
				`DELETE FROM task_relations WHERE task_id IN (${ph}) OR other_task_id IN (${ph})`,
				[...taskIds, ...taskIds],
			)
			// Kind numbering differs per table, matching the Go constants: reactions
			// count task from 0, favourites from 1, and subscriptions skip 1 for a
			// retired namespace entity.
			await conn.query(`DELETE FROM reactions WHERE entity_kind = 0 AND entity_id IN (${ph})`, taskIds)
			await conn.query(`DELETE FROM favorites WHERE kind = 1 AND entity_id IN (${ph})`, taskIds)
			await conn.query(`DELETE FROM subscriptions WHERE entity_type = 3 AND entity_id IN (${ph})`, taskIds)

			const [commentRows] = await conn.query('SELECT id FROM task_comments WHERE task_id IN (' + ph + ')', taskIds)
			if (commentRows.length > 0) {
				const cph = commentRows.map(() => '?').join(',')
				await conn.query(`DELETE FROM reactions WHERE entity_kind = 1 AND entity_id IN (${cph})`,
					commentRows.map(r => r.id))
			}
		}

		await conn.query(
			'DELETE FROM buckets WHERE project_view_id IN (SELECT id FROM project_views WHERE project_id = ?)',
			[projectId],
		)

		for (const table of [
			'tasks', 'project_views', 'storage_items', 'users_projects',
			'team_projects', 'link_shares', 'webhooks', 'time_entries',
		]) {
			await conn.query(`DELETE FROM ${table} WHERE project_id = ?`, [projectId])
		}
		await conn.query('DELETE FROM subscriptions WHERE entity_type = 2 AND entity_id = ?', [projectId])
		await conn.query('DELETE FROM favorites WHERE kind = 2 AND entity_id = ?', [projectId])

		await conn.query('DELETE FROM projects WHERE id = ?', [projectId])
	})

	// After the rows are gone: a failed unlink must not roll back the delete, and
	// a leftover blob is harmless next to a dangling database row.
	for (const fileId of fileIds) {
		await query('DELETE FROM files WHERE id = ?', [fileId]).catch(() => {})
		await fsp.rm(path.join(config.filesPath, String(fileId)), {force: true}).catch(() => {})
	}
}
