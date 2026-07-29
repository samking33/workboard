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
