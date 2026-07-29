import {query} from './db.js'
import {notify, taskUrl} from './notify.js'
import {rollRepeatingTask} from './repeat.js'

/**
 * Background jobs. Plain setInterval rather than a cron library: these run on
 * fixed short periods, and a dependency to express "every minute" is not worth
 * it.
 *
 * Each job checks whether its work has already been done before doing it, so a
 * second instance running the same schedule duplicates nothing.
 */

const MINUTE = 60 * 1000

/**
 * Sends reminders that have come due.
 *
 * There is no `notified` column on task_reminders — the Go schema has none, and
 * adding one would diverge from a database both servers may touch. Instead the
 * already-sent notification is itself the record: a reminder is skipped once a
 * task.reminder notification exists for that user and task since the reminder
 * time. That also means a missed tick still sends late rather than never, which
 * the upstream one-minute window does not.
 *
 * The 24h floor keeps this from resurrecting very old reminders after downtime.
 */
async function sendDueReminders() {
	const due = await query(
		`SELECT r.task_id, r.reminder, t.title, t.project_id
		 FROM task_reminders r
		 JOIN tasks t ON t.id = r.task_id
		 WHERE r.reminder <= UTC_TIMESTAMP()
		   AND r.reminder > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
		   AND t.done = 0
		   AND t.deleted_at IS NULL`,
	)

	let sent = 0
	for (const row of due) {
		const assignees = await query(
			`SELECT u.id, u.email_reminders_enabled FROM task_assignees ta
			 JOIN users u ON u.id = ta.user_id WHERE ta.task_id = ?`,
			[row.task_id],
		)

		for (const a of assignees) {
			const already = await query(
				`SELECT 1 FROM notifications
				 WHERE notifiable_id = ? AND name = 'task.reminder' AND subject_id = ? AND created >= ?
				 LIMIT 1`,
				[a.id, row.task_id, row.reminder],
			)
			if (already.length > 0) {
				continue
			}

			await notify(
				a.id,
				'task.reminder',
				{task: {id: row.task_id, title: row.title}, project: {id: row.project_id}},
				a.email_reminders_enabled
					? {
						subject: `Reminder: ${row.title}`,
						heading: 'A task needs your attention',
						lines: [`"${row.title}" is due.`],
						action: {label: 'Open the task', url: taskUrl(row.task_id)},
					}
					: null,
			)
			sent++
		}
	}

	return sent
}

/**
 * Once a day, tells each user which of their tasks are overdue.
 *
 * Digest rather than one mail per task: someone back from a week off would
 * otherwise get twenty separate emails.
 */
async function sendOverdueDigest() {
	const rows = await query(
		`SELECT ta.user_id, t.id, t.title, t.due_date
		 FROM tasks t
		 JOIN task_assignees ta ON ta.task_id = t.id
		 JOIN users u ON u.id = ta.user_id
		 WHERE t.done = 0 AND t.deleted_at IS NULL
		   AND t.due_date IS NOT NULL AND t.due_date < UTC_TIMESTAMP()
		   AND u.overdue_tasks_reminders_enabled = 1
		 ORDER BY ta.user_id, t.due_date`,
	)

	const byUser = new Map()
	for (const r of rows) {
		if (!byUser.has(r.user_id)) {
			byUser.set(r.user_id, [])
		}
		byUser.get(r.user_id).push(r)
	}

	for (const [userId, tasks] of byUser) {
		await notify(
			userId,
			'task.undone.overdue',
			{tasks: tasks.map(t => ({id: t.id, title: t.title, due_date: t.due_date}))},
			{
				subject: `${tasks.length} overdue task${tasks.length === 1 ? '' : 's'}`,
				heading: 'These tasks are past their due date',
				lines: tasks.slice(0, 20).map(t => `${t.title} — was due ${new Date(t.due_date).toDateString()}`),
				action: {label: 'Open FSOC', url: taskUrl(tasks[0].id)},
			},
		)
	}

	return byUser.size
}

/**
 * Safety net for repeating tasks. They are normally rolled forward the instant
 * they are completed; this catches any that were marked done by a path that
 * missed that, or by the Go server.
 */
async function rollStuckRepeatingTasks() {
	const rows = await query(
		`SELECT id FROM tasks
		 WHERE done = 1 AND deleted_at IS NULL
		   AND (repeat_after > 0 OR repeat_mode = 1)
		   AND done_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)`,
	)

	let rolled = 0
	for (const t of rows) {
		if (await rollRepeatingTask(t.id)) {
			rolled++
		}
	}
	return rolled
}

/**
 * Carries out account deletions whose grace period has run out.
 *
 * Imported lazily: account.js pulls in the project cascade, which pulls in this
 * module's siblings, and a top-level import here would be circular.
 */
async function runScheduledDeletions() {
	const due = await query(
		`SELECT id, username FROM users
		 WHERE deletion_scheduled_at IS NOT NULL AND deletion_scheduled_at <= UTC_TIMESTAMP()`,
	)

	const {deleteUserAccount} = await import('../routes/account.js')
	for (const user of due) {
		console.log(`[fsoc] deleting account ${user.username} (${user.id}) as scheduled`)
		await deleteUserAccount(user.id)
	}
	return due.length
}

async function run(label, job) {
	try {
		const n = await job()
		if (n > 0) {
			console.log(`[fsoc] ${label}: ${n}`)
		}
	} catch (err) {
		// A failing job must never take the server down with it.
		console.error(`[fsoc] job ${label} failed: ${err.message}`)
	}
}

export function startCron() {
	setInterval(() => run('reminders sent', sendDueReminders), MINUTE).unref()
	setInterval(() => run('stuck repeating tasks rolled forward', rollStuckRepeatingTasks), 10 * MINUTE).unref()
	setInterval(() => run('overdue digests sent', sendOverdueDigest), 24 * 60 * MINUTE).unref()
	setInterval(() => run('scheduled account deletions', runScheduledDeletions), 60 * MINUTE).unref()

	console.log('[fsoc] background jobs started')
}
