import {one, query} from './db.js'

// Matches the Go RepeatMode constants.
const REPEAT_DEFAULT = 0
const REPEAT_MONTHLY = 1
const REPEAT_FROM_CURRENT_DATE = 2

/**
 * Rolls a repeating task forward instead of letting it stay done.
 *
 * Called the moment a task is completed — from the list checkbox and from a
 * drop into the done bucket — rather than on a timer, so the task never sits
 * visibly done before reappearing.
 *
 * @returns {boolean} whether the task repeats (and so was rolled forward)
 */
export async function rollRepeatingTask(taskId) {
	const task = await one(
		'SELECT id, due_date, start_date, end_date, repeat_after, repeat_mode FROM tasks WHERE id = ?',
		[taskId],
	)

	const mode = Number(task?.repeat_mode ?? 0)
	if (!task || (mode !== REPEAT_MONTHLY && Number(task.repeat_after) <= 0)) {
		return false
	}

	const shift = date => {
		if (!date) {
			return null
		}
		const from = mode === REPEAT_FROM_CURRENT_DATE ? new Date() : new Date(date)
		if (mode === REPEAT_MONTHLY) {
			const next = new Date(from)
			next.setMonth(next.getMonth() + 1)
			return next
		}
		return new Date(from.getTime() + Number(task.repeat_after) * 1000)
	}

	// A repeating task with no dates at all would just be un-done forever, which
	// is not useful — leave it completed.
	if (!task.due_date && !task.start_date && !task.end_date) {
		return false
	}

	await query(
		`UPDATE tasks SET done = 0, done_at = NULL,
		 due_date = ?, start_date = ?, end_date = ?, updated = UTC_TIMESTAMP()
		 WHERE id = ?`,
		[shift(task.due_date), shift(task.start_date), shift(task.end_date), task.id],
	)

	// Reminders move with the dates they were set against, otherwise the next
	// cycle either fires immediately or not at all.
	const reminders = await query(
		'SELECT id, reminder FROM task_reminders WHERE task_id = ?', [task.id])
	for (const r of reminders) {
		await query('UPDATE task_reminders SET reminder = ? WHERE id = ?', [shift(r.reminder), r.id])
	}

	return true
}
