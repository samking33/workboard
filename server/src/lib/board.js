import {query} from './db.js'
import {shapeTasks} from './shape.js'

/**
 * Builds a kanban board: every bucket in the view, each with its cards.
 *
 * Two endpoints answer with this — /buckets, and /views/:view/tasks when the
 * view is a kanban one, because the client fetches a board through the task
 * collection route and tells buckets from tasks by project_view_id being
 * present on the object.
 *
 * @param {object} [filter] optional {where, params} from the query string
 */
export async function bucketsWithTasks(viewId, filter = {}) {
	const buckets = await query(
		'SELECT id, title, project_view_id, `limit`, position, created, updated FROM buckets WHERE project_view_id = ? ORDER BY position, id',
		[viewId],
	)
	if (buckets.length === 0) {
		return []
	}

	// One query for the whole board rather than one per column — a project with
	// a dozen buckets otherwise costs a dozen round trips per load.
	const rows = await query(
		`SELECT t.*, tb.bucket_id FROM task_buckets tb
		 JOIN tasks t ON t.id = tb.task_id
		 LEFT JOIN task_positions tp ON tp.task_id = t.id AND tp.project_view_id = tb.project_view_id
		 WHERE tb.project_view_id = ? AND t.deleted_at IS NULL${filter.where ?? ''}
		 ORDER BY COALESCE(tp.position, t.\`index\` * 65536), t.id`,
		[viewId, ...(filter.params ?? [])],
	)

	const byBucket = new Map()
	for (const r of rows) {
		if (!byBucket.has(r.bucket_id)) {
			byBucket.set(r.bucket_id, [])
		}
		byBucket.get(r.bucket_id).push(r)
	}

	const positions = await query(
		'SELECT task_id, position FROM task_positions WHERE project_view_id = ?', [viewId])
	const positionByTask = new Map(positions.map(p => [p.task_id, p.position]))

	const bucketByTask = new Map(rows.map(r => [r.id, r.bucket_id]))

	return Promise.all(buckets.map(async b => {
		const bucketRows = byBucket.get(b.id) ?? []
		return {
			...b,
			tasks: await shapeTasks(bucketRows, {positionByTask, bucketByTask}),
			count: bucketRows.length,
		}
	}))
}
