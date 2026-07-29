import express from 'express'

import {requireAuth} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {bucketsWithTasks} from '../lib/board.js'
import {buildFilter, buildOrderBy} from '../lib/filter.js'
import {
	PERMISSION_READ,
	PERMISSION_WRITE,
	canReadProject,
	canWriteProject,
	requireProject,
	visibleProjectIdsFor,
} from '../lib/permissions.js'
import {shapeTask, shapeTasks} from '../lib/shape.js'
import {notify, taskUrl} from '../lib/notify.js'
import {rollRepeatingTask} from '../lib/repeat.js'
import addTaskToViews from '../lib/taskViews.js'
import {dispatchWebhook} from '../lib/webhooks.js'
import {
	attachmentsForTask,
	relationsForTask,
	remindersForTask,
	replaceReminders,
} from './taskDetail.js'

export const tasksRouter = express.Router()
tasksRouter.use(requireAuth)

const MAX_PER_PAGE = 250

function pagination(req) {
	const page = Math.max(1, Number(req.query.page ?? 1))
	const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query.per_page ?? 50)))
	return {limit: perPage, offset: (page - 1) * perPage}
}

/**
 * Turns ?filter=/?s=/?sort_by= into SQL fragments.
 *
 * Returns a `bad` message instead of throwing so the caller answers 400 — a
 * filter we cannot parse must not fall through to an unfiltered list, which
 * would quietly show tasks the user was trying to filter out.
 */
function listQuery(req) {
	const clauses = []
	const params = []

	try {
		const filter = buildFilter(req.query.filter)
		if (filter) {
			clauses.push(filter.sql)
			params.push(...filter.params)
		}
	} catch (err) {
		return {bad: err.message}
	}

	const search = String(req.query.s ?? '').trim()
	if (search) {
		clauses.push('(t.title LIKE ? OR t.description LIKE ?)')
		params.push(`%${search}%`, `%${search}%`)
	}

	return {
		where: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
		params,
		orderBy: buildOrderBy(req.query.sort_by, req.query.order_by),
	}
}

/** Loads a task and the caller's permission on its project in one step. */
async function loadTaskFor(userId, taskId, level) {
	const task = await one(
		'SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL',
		[taskId],
	)
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

// --- tasks in a project ------------------------------------------------

tasksRouter.get(
	'/projects/:project(\\d+)/tasks',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const q = listQuery(req)
			if (q.bad) {
				return res.status(400).json({message: q.bad})
			}

			const {limit, offset} = pagination(req)
			const total = await one(
				`SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.deleted_at IS NULL${q.where}`,
				[req.projectId, ...q.params],
			)
			const rows = await query(
				`SELECT t.* FROM tasks t
				 WHERE t.project_id = ? AND t.deleted_at IS NULL${q.where}
				 ORDER BY ${q.orderBy ?? 't.`index` DESC'} LIMIT ? OFFSET ?`,
				[req.projectId, ...q.params, limit, offset],
			)
			res.paginate?.(Number(total.n), limit)
			return res.json(await shapeTasks(rows))
		} catch (err) {
			return next(err)
		}
	},
)

// The client fetches a view's tasks through the view, so buckets and positions
// can come back with them.
tasksRouter.get(
	'/projects/:project(\\d+)/views/:view(\\d+)/tasks',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const viewId = Number(req.params.view)
			const view = await one(
				'SELECT id, view_kind, filter FROM project_views WHERE id = ? AND project_id = ?',
				[viewId, req.projectId],
			)
			if (!view) {
				return res.status(404).json({message: 'view not found'})
			}

			const q = listQuery(req)
			if (q.bad) {
				return res.status(400).json({message: q.bad})
			}

			// A kanban view answers with its buckets, each carrying its cards — the
			// client's model factory switches on project_view_id being present and
			// builds a board from it. Returning a flat task list here renders three
			// empty columns.
			if (view.view_kind === 3) {
				return res.json(await bucketsWithTasks(viewId, q))
			}

			// A view carries its own saved filter; both apply, so a view showing only
			// open tasks cannot be widened by the query string.
			let viewWhere = ''
			const viewParams = []
			if (view.filter) {
				try {
					const vf = buildFilter(view.filter)
					if (vf) {
						viewWhere = ` AND ${vf.sql}`
						viewParams.push(...vf.params)
					}
				} catch {
					// A view saved by the Go server may use syntax we do not parse.
					// Ignoring it shows more than intended, so fail instead.
					return res.status(500).json({message: `this view has a filter this server cannot parse: ${view.filter}`})
				}
			}

			const {limit, offset} = pagination(req)
			const rows = await query(
				`SELECT t.* FROM tasks t
				 LEFT JOIN task_positions tp ON tp.task_id = t.id AND tp.project_view_id = ?
				 WHERE t.project_id = ? AND t.deleted_at IS NULL${viewWhere}${q.where}
				 ORDER BY ${q.orderBy ?? 'COALESCE(tp.position, t.`index` * 65536), t.id'}
				 LIMIT ? OFFSET ?`,
				[viewId, req.projectId, ...viewParams, ...q.params, limit, offset],
			)

			const ids = rows.map(r => r.id)
			const bucketByTask = new Map()
			const positionByTask = new Map()

			if (ids.length > 0) {
				const ph = ids.map(() => '?').join(',')
				const buckets = await query(
					`SELECT task_id, bucket_id FROM task_buckets
					 WHERE project_view_id = ? AND task_id IN (${ph})`,
					[viewId, ...ids],
				)
				for (const b of buckets) {
					bucketByTask.set(b.task_id, b.bucket_id)
				}

				const positions = await query(
					`SELECT task_id, position FROM task_positions
					 WHERE project_view_id = ? AND task_id IN (${ph})`,
					[viewId, ...ids],
				)
				for (const p of positions) {
					positionByTask.set(p.task_id, p.position)
				}
			}

			return res.json(await shapeTasks(rows, {bucketByTask, positionByTask}))
		} catch (err) {
			return next(err)
		}
	},
)

// --- cross-project task lists -----------------------------------------

// Backs "Upcoming" and "My Tasks". Scoped to projects the caller can reach.
tasksRouter.get(['/tasks', '/tasks/all'], async (req, res, next) => {
	try {
		const ids = await visibleProjectIdsFor(req)
		if (ids.length === 0) {
			return res.json([])
		}

		const q = listQuery(req)
		if (q.bad) {
			return res.status(400).json({message: q.bad})
		}

		const ph = ids.map(() => '?').join(',')
		const {limit, offset} = pagination(req)
		const rows = await query(
			`SELECT t.* FROM tasks t
			 WHERE t.project_id IN (${ph}) AND t.deleted_at IS NULL${q.where}
			 ORDER BY ${q.orderBy ?? 't.due_date IS NULL, t.due_date, t.id'}
			 LIMIT ? OFFSET ?`,
			[...ids, ...q.params, limit, offset],
		)
		return res.json(await shapeTasks(rows))
	} catch (err) {
		return next(err)
	}
})

// --- single task -------------------------------------------------------

tasksRouter.get('/tasks/:task(\\d+)', async (req, res, next) => {
	try {
		const found = await loadTaskFor(req.user.id, Number(req.params.task), PERMISSION_READ)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}
		const [shaped] = await shapeTasks([found.task])
		// Only the single-task read loads these: doing it per row would mean
		// three extra queries for every task in a 250-row list page.
		shaped.related_tasks = await relationsForTask(found.task.id)
		shaped.reminders = await remindersForTask(found.task.id)
		shaped.attachments = await attachmentsForTask(found.task.id)
		return res.json(shaped)
	} catch (err) {
		return next(err)
	}
})

tasksRouter.put(
	'/projects/:project(\\d+)/tasks',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const {title, description = '', due_date: dueDate = null, priority = 0} = req.body ?? {}
			if (!title || !String(title).trim()) {
				return res.status(400).json({message: 'a title is required'})
			}

			// `index` is per project and shown to users as #n.
			const maxRow = await one(
				'SELECT COALESCE(MAX(`index`), 0) AS max_index FROM tasks WHERE project_id = ?',
				[req.projectId],
			)

			const result = await query(
				`INSERT INTO tasks (title, description, project_id, done, priority, due_date,
				                    \`index\`, created_by_id, created, updated)
				 VALUES (?, ?, ?, 0, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[
					String(title).trim(), description, req.projectId, priority,
					dueDate ? new Date(dueDate) : null,
					Number(maxRow.max_index) + 1, req.user.id,
				],
			)

			await addTaskToViews(result.insertId, req.projectId, Number(maxRow.max_index) + 1)

			const row = await one('SELECT * FROM tasks WHERE id = ?', [result.insertId])
			const created = shapeTask(row)
			dispatchWebhook(req.projectId, 'task.created', {task: created}, req.user)
			return res.status(201).json(created)
		} catch (err) {
			return next(err)
		}
	},
)

const UPDATABLE = {
	title: 'title',
	description: 'description',
	done: 'done',
	due_date: 'due_date',
	start_date: 'start_date',
	end_date: 'end_date',
	priority: 'priority',
	percent_done: 'percent_done',
	hex_color: 'hex_color',
	repeat_after: 'repeat_after',
	repeat_mode: 'repeat_mode',
}

tasksRouter.post('/tasks/:task(\\d+)', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const sets = []
		const params = []
		for (const [key, column] of Object.entries(UPDATABLE)) {
			if (req.body?.[key] === undefined) {
				continue
			}
			let value = req.body[key]
			if (['due_date', 'start_date', 'end_date'].includes(key)) {
				value = value ? new Date(value) : null
			}
			if (key === 'done') {
				value = value ? 1 : 0
				// done_at drives "completed on" in the UI.
				sets.push('done_at = ' + (value ? 'UTC_TIMESTAMP()' : 'NULL'))
			}
			sets.push(`\`${column}\` = ?`)
			params.push(value)
		}

		if (sets.length > 0) {
			sets.push('updated = UTC_TIMESTAMP()')
			await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, [...params, taskId])
		}

		// The client sends the whole reminder set, so replace rather than merge.
		if (Array.isArray(req.body?.reminders)) {
			await replaceReminders(taskId, req.body.reminders)
		}

		// Ticking a task off in the list has to move its card too, or the board
		// keeps showing it as in progress.
		if (req.body?.done !== undefined) {
			await syncDoneBucket(taskId, found.task.project_id, Boolean(req.body.done))
			// A repeating task reappears with its next set of dates rather than
			// staying completed.
			if (req.body.done) {
				await rollRepeatingTask(taskId)
			}
		}

		const row = await one('SELECT * FROM tasks WHERE id = ?', [taskId])
		const [shaped] = await shapeTasks([row])
		shaped.related_tasks = await relationsForTask(taskId)
		shaped.reminders = await remindersForTask(taskId)
		shaped.attachments = await attachmentsForTask(taskId)
		dispatchWebhook(found.task.project_id, 'task.updated', {task: shaped}, req.user)
		return res.json(shaped)
	} catch (err) {
		return next(err)
	}
})

tasksRouter.delete('/tasks/:task(\\d+)', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		// Soft delete: the Go schema keeps the row and filters on deleted_at, so
		// hard-deleting here would diverge from data written by the old server.
		await query('UPDATE tasks SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [taskId])
		dispatchWebhook(found.task.project_id, 'task.deleted', {task: shapeTask(found.task)}, req.user)
		return res.json({message: 'task deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- drag reordering ---------------------------------------------------

// The client computes the new position as the midpoint between the two cards a
// dragged task was dropped between, so the server only stores what it is told.
tasksRouter.post('/tasks/:task(\\d+)/position', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const viewId = Number(req.body?.project_view_id)
		const position = Number(req.body?.position)
		if (!Number.isInteger(viewId) || !Number.isFinite(position)) {
			return res.status(400).json({message: 'project_view_id and a numeric position are required'})
		}

		// The view has to belong to the task's own project, otherwise a position
		// could be written into a view the caller has no access to.
		const view = await one('SELECT id FROM project_views WHERE id = ? AND project_id = ?',
			[viewId, found.task.project_id])
		if (!view) {
			return res.status(404).json({message: 'view not found in this task\'s project'})
		}

		await query(
			`INSERT INTO task_positions (task_id, project_view_id, position) VALUES (?, ?, ?)
			 ON DUPLICATE KEY UPDATE position = VALUES(position)`,
			[taskId, viewId, position],
		)

		return res.json({task_id: taskId, project_view_id: viewId, position})
	} catch (err) {
		return next(err)
	}
})

// --- assignees ---------------------------------------------------------

tasksRouter.put('/tasks/:task(\\d+)/assignees', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const userId = Number(req.body?.user_id)
		if (!Number.isInteger(userId)) {
			return res.status(400).json({message: 'user_id is required'})
		}

		// An assignee who cannot see the project would be invisible to themselves.
		if (!(await canReadProject(userId, found.task.project_id))) {
			return res.status(400).json({message: 'that user has no access to this project'})
		}

		await query(
			`INSERT INTO task_assignees (task_id, user_id, created)
			 SELECT ?, ?, UTC_TIMESTAMP() FROM DUAL
			 WHERE NOT EXISTS (SELECT 1 FROM task_assignees WHERE task_id = ? AND user_id = ?)`,
			[taskId, userId, taskId, userId],
		)
		dispatchWebhook(found.task.project_id, 'task.assignee.created',
			{task_id: taskId, user_id: userId}, req.user)

		// Being given a task is the one thing people most need to hear about, so
		// it notifies even when the assigner is assigning to themselves elsewhere.
		if (userId !== req.user.id) {
			await notify(
				userId,
				'task.assigned',
				{task: {id: taskId, title: found.task.title}, doer: {id: req.user.id, username: req.user.username}},
				{
					subject: `${req.user.username} assigned you "${found.task.title}"`,
					heading: 'A task was assigned to you',
					lines: [`${req.user.username} assigned you "${found.task.title}".`],
					action: {label: 'Open the task', url: taskUrl(taskId)},
				},
			)
		}
		return res.status(201).json({user_id: userId, created: new Date()})
	} catch (err) {
		return next(err)
	}
})

tasksRouter.delete('/tasks/:task(\\d+)/assignees/:user(\\d+)', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		await query('DELETE FROM task_assignees WHERE task_id = ? AND user_id = ?',
			[taskId, Number(req.params.user)])
		dispatchWebhook(found.task.project_id, 'task.assignee.deleted',
			{task_id: taskId, user_id: Number(req.params.user)}, req.user)
		return res.json({message: 'assignee removed'})
	} catch (err) {
		return next(err)
	}
})

// --- labels on a task --------------------------------------------------

tasksRouter.put('/tasks/:task(\\d+)/labels', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		const labelId = Number(req.body?.label_id)
		if (!Number.isInteger(labelId)) {
			return res.status(400).json({message: 'label_id is required'})
		}

		await query(
			`INSERT INTO label_tasks (task_id, label_id, created)
			 SELECT ?, ?, UTC_TIMESTAMP() FROM DUAL
			 WHERE NOT EXISTS (SELECT 1 FROM label_tasks WHERE task_id = ? AND label_id = ?)`,
			[taskId, labelId, taskId, labelId],
		)
		return res.status(201).json({label_id: labelId})
	} catch (err) {
		return next(err)
	}
})

tasksRouter.delete('/tasks/:task(\\d+)/labels/:label(\\d+)', async (req, res, next) => {
	try {
		const taskId = Number(req.params.task)
		const found = await loadTaskFor(req.user.id, taskId, PERMISSION_WRITE)
		if (found.status) {
			return res.status(found.status).json({message: found.message})
		}

		await query('DELETE FROM label_tasks WHERE task_id = ? AND label_id = ?',
			[taskId, Number(req.params.label)])
		return res.json({message: 'label removed'})
	} catch (err) {
		return next(err)
	}
})
