import {query} from './db.js'

/**
 * Row -> wire shapes.
 *
 * The Vue client was written against the Go API, so these must match its JSON
 * exactly: snake_case keys, and relations present as arrays/objects rather than
 * ids. A missing key usually shows up as a blank field in the UI rather than an
 * error, so they are filled explicitly.
 */

export function shapeUser(row) {
	if (!row) {
		return null
	}
	return {
		id: row.id,
		username: row.username,
		name: row.name ?? '',
		email: row.email ?? '',
		created: row.created,
		updated: row.updated,
	}
}

export function shapeLabel(row) {
	return {
		id: row.id,
		title: row.title,
		description: row.description ?? '',
		hex_color: row.hex_color ?? '',
		created_by: shapeUser(row.created_by ?? null),
		created: row.created,
		updated: row.updated,
	}
}

export function shapeTask(row, {assignees = [], labels = [], bucketId = null, position = null} = {}) {
	return {
		id: row.id,
		title: row.title,
		description: row.description ?? '',
		done: Boolean(row.done),
		done_at: row.done_at,
		due_date: row.due_date,
		start_date: row.start_date,
		end_date: row.end_date,
		project_id: row.project_id,
		repeat_after: row.repeat_after ?? 0,
		repeat_mode: row.repeat_mode ?? 0,
		priority: row.priority ?? 0,
		hex_color: row.hex_color ?? '',
		percent_done: row.percent_done ?? 0,
		index: row.index,
		identifier: row.index ? `#${row.index}` : '',
		uid: row.uid ?? '',
		cover_image_attachment_id: row.cover_image_attachment_id ?? 0,
		is_favorite: false,
		assignees: assignees.map(shapeUser),
		labels: labels.map(shapeLabel),
		// Present so the Kanban board can place the card without a second call.
		bucket_id: bucketId,
		position,
		related_tasks: {},
		attachments: [],
		reminders: [],
		created_by: shapeUser(row.created_by ?? null),
		created: row.created,
		updated: row.updated,
	}
}

/**
 * Loads assignees and labels for a batch of tasks in two queries rather than
 * two per task — the list views fetch 50+ at a time.
 */
export async function loadTaskRelations(taskIds) {
	const empty = {assignees: new Map(), labels: new Map()}
	if (taskIds.length === 0) {
		return empty
	}

	const placeholders = taskIds.map(() => '?').join(',')

	const assigneeRows = await query(
		`SELECT ta.task_id, u.id, u.username, u.name, u.email, u.created, u.updated
		 FROM task_assignees ta JOIN users u ON u.id = ta.user_id
		 WHERE ta.task_id IN (${placeholders})`,
		taskIds,
	)
	const labelRows = await query(
		`SELECT lt.task_id, l.id, l.title, l.description, l.hex_color, l.created, l.updated
		 FROM label_tasks lt JOIN labels l ON l.id = lt.label_id
		 WHERE lt.task_id IN (${placeholders})`,
		taskIds,
	)

	const assignees = new Map()
	for (const r of assigneeRows) {
		if (!assignees.has(r.task_id)) {
			assignees.set(r.task_id, [])
		}
		assignees.get(r.task_id).push(r)
	}

	const labels = new Map()
	for (const r of labelRows) {
		if (!labels.has(r.task_id)) {
			labels.set(r.task_id, [])
		}
		labels.get(r.task_id).push(r)
	}

	return {assignees, labels}
}

/** Attaches relations to a set of task rows, preserving order. */
export async function shapeTasks(rows, {bucketByTask = new Map(), positionByTask = new Map()} = {}) {
	const ids = rows.map(r => r.id)
	const {assignees, labels} = await loadTaskRelations(ids)
	return rows.map(r => shapeTask(r, {
		assignees: assignees.get(r.id) ?? [],
		labels: labels.get(r.id) ?? [],
		bucketId: bucketByTask.get(r.id) ?? null,
		position: positionByTask.get(r.id) ?? null,
	}))
}
