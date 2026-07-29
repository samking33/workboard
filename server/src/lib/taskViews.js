import {one, query} from './db.js'

/**
 * Gives a task a place in every view of its project.
 *
 * Both halves matter: without a task_positions row the task sorts by `index`
 * while its reordered siblings sort by position, and the two scales interleave
 * wrongly; without a task_buckets row the task never appears on the board at
 * all. The 2^16 multiplier matches the Go server so positions stay comparable
 * across rows either server wrote, and leaves room to drop cards between.
 *
 * Shared by the API, the importers and CalDAV — every path that creates a task
 * has to do this, and three copies would drift.
 */
export default async function addTaskToViews(taskId, projectId, index, done = false) {
	const views = await query(
		'SELECT id, view_kind, default_bucket_id, done_bucket_id FROM project_views WHERE project_id = ?',
		[projectId],
	)

	for (const view of views) {
		await query(
			`INSERT INTO task_positions (task_id, project_view_id, position) VALUES (?, ?, ?)
			 ON DUPLICATE KEY UPDATE position = VALUES(position)`,
			[taskId, view.id, index * 65536],
		)

		if (view.view_kind !== 3) {
			continue
		}

		let bucketId = done ? (view.done_bucket_id || view.default_bucket_id) : view.default_bucket_id
		if (!bucketId) {
			const first = await one(
				'SELECT id FROM buckets WHERE project_view_id = ? ORDER BY position, id LIMIT 1',
				[view.id],
			)
			bucketId = first?.id
		}
		if (bucketId) {
			await query(
				`INSERT INTO task_buckets (bucket_id, task_id, project_view_id) VALUES (?, ?, ?)
				 ON DUPLICATE KEY UPDATE bucket_id = VALUES(bucket_id)`,
				[bucketId, taskId, view.id],
			)
		}
	}
}

/**
 * Moves an existing task's card to the done bucket, or back to the default one.
 *
 * Lives here rather than in the tasks route because ticking a task off in a list
 * and dragging its card are the same state change seen from two places, and the
 * board is wrong if only one of them updates.
 */
export async function syncDoneBucket(taskId, projectId, done) {
	const views = await query(
		'SELECT id, default_bucket_id, done_bucket_id FROM project_views WHERE project_id = ? AND view_kind = 3',
		[projectId],
	)

	for (const view of views) {
		let target = done ? view.done_bucket_id : view.default_bucket_id
		if (!target) {
			// A board built before done_bucket_id was set: fall back to the last
			// column for done and the first for not-done.
			const fallback = await one(
				`SELECT id FROM buckets WHERE project_view_id = ? ORDER BY position ${done ? 'DESC' : 'ASC'}, id LIMIT 1`,
				[view.id],
			)
			target = fallback?.id
		}
		if (target) {
			await query(
				`INSERT INTO task_buckets (bucket_id, task_id, project_view_id) VALUES (?, ?, ?)
				 ON DUPLICATE KEY UPDATE bucket_id = VALUES(bucket_id)`,
				[target, taskId, view.id],
			)
		}
	}
}
