import {config} from './config.js'
import {one, query} from './db.js'
import {sendMail} from './mail.js'

/**
 * Writes an in-app notification and, when mail is configured, emails it.
 *
 * The row shape matches what the Go server wrote, so the existing client renders
 * these without changes and old notifications keep working.
 */
export async function notify(userId, name, payload, mail = null) {
	if (!userId) {
		return
	}

	await query(
		'INSERT INTO notifications (notifiable_id, notification, name, subject_id, created) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
		[userId, JSON.stringify(payload), name, payload?.task?.id ?? payload?.project?.id ?? 0],
	)

	if (!mail) {
		return
	}

	const user = await one('SELECT email, username FROM users WHERE id = ?', [userId])
	if (user?.email) {
		await sendMail({to: user.email, ...mail})
	}
}

export function taskUrl(taskId) {
	return new URL(`/tasks/${taskId}`, config.publicUrl).toString()
}

/** Everyone who should hear about a change to this task, minus whoever made it. */
export async function taskAudience(taskId, excludeUserId) {
	const rows = await query(
		`SELECT DISTINCT u.id FROM users u
		 WHERE u.id IN (
		   SELECT ta.user_id FROM task_assignees ta WHERE ta.task_id = ?
		   UNION
		   SELECT s.user_id FROM subscriptions s WHERE s.entity_type = 3 AND s.entity_id = ?
		   UNION
		   SELECT s.user_id FROM subscriptions s
		     JOIN tasks t ON t.id = ?
		     WHERE s.entity_type = 2 AND s.entity_id = t.project_id
		 )`,
		[taskId, taskId, taskId],
	)

	return rows.map(r => r.id).filter(id => id !== excludeUserId)
}
