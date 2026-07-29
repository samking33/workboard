import crypto from 'node:crypto'

import {one, query} from './db.js'
import {postJson} from './outbound.js'

export const WEBHOOK_EVENTS = [
	'task.created',
	'task.updated',
	'task.deleted',
	'task.assignee.created',
	'task.assignee.deleted',
	'task.comment.created',
	'task.comment.edited',
	'task.comment.deleted',
	'task.attachment.created',
	'task.attachment.deleted',
	'task.relation.created',
	'task.relation.deleted',
	'project.created',
	'project.updated',
	'project.deleted',
	'project.shared.user',
	'project.shared.team',
]

/**
 * Fires every webhook registered on a project for this event.
 *
 * Deliberately not awaited by callers: a slow or dead endpoint must not hold up
 * the user's request, and a webhook failing is not a reason to fail the action
 * that triggered it. Failures are logged and dropped — retries would need a
 * queue with persistence, which is not here yet.
 */
export function dispatchWebhook(projectId, eventName, payload, actor) {
	setImmediate(async () => {
		try {
			const hooks = await query('SELECT * FROM webhooks WHERE project_id = ?', [projectId])

			for (const hook of hooks) {
				let events = []
				try {
					events = JSON.parse(hook.events ?? '[]')
				} catch {
					events = String(hook.events ?? '').split(',').map(e => e.trim()).filter(Boolean)
				}
				if (!events.includes(eventName)) {
					continue
				}

				const body = {
					event_name: eventName,
					time: new Date().toISOString(),
					data: payload,
					doer: actor ? {id: actor.id, username: actor.username} : null,
				}

				const headers = {}
				if (hook.secret) {
					// Lets the receiver verify we sent it. Same scheme and header name
					// as the Go server so existing receivers keep working.
					headers['X-Vikunja-Signature'] = crypto
						.createHmac('sha256', hook.secret)
						.update(JSON.stringify(body))
						.digest('hex')
				}
				if (hook.basic_auth_user && hook.basic_auth_password) {
					const pair = `${hook.basic_auth_user}:${hook.basic_auth_password}`
					headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`
				}

				try {
					const res = await postJson(hook.target_url, body, {headers})
					if (res.status > 399) {
						console.error(`[fsoc] webhook ${hook.id} -> ${res.status}: ${res.body.slice(0, 200)}`)
					}
				} catch (err) {
					console.error(`[fsoc] webhook ${hook.id} failed: ${err.message}`)
				}
			}
		} catch (err) {
			console.error(`[fsoc] dispatching webhooks failed: ${err.message}`)
		}
	})
}

/** Resolves the project a task belongs to, for task-level events. */
export async function dispatchTaskWebhook(taskId, eventName, payload, actor) {
	const task = await one('SELECT project_id FROM tasks WHERE id = ?', [taskId])
	if (task) {
		dispatchWebhook(task.project_id, eventName, payload, actor)
	}
}
