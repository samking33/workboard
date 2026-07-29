import crypto from 'node:crypto'
import net from 'node:net'

import express from 'express'

import {requireAuth} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {isBlockedAddress} from '../lib/outbound.js'
import {PERMISSION_ADMIN, requireProject} from '../lib/permissions.js'
import {WEBHOOK_EVENTS} from '../lib/webhooks.js'

export const webhooksRouter = express.Router()
webhooksRouter.use(requireAuth)

/**
 * Webhooks are admin-only throughout: the target URL makes the server issue
 * requests, and the stored secret authenticates us to the receiver.
 */

webhooksRouter.get('/webhooks/events', (req, res) => {
	return res.json(WEBHOOK_EVENTS)
})

function shapeWebhook(row) {
	return {
		id: row.id,
		target_url: row.target_url,
		events: safeEvents(row.events),
		project_id: row.project_id,
		created_by_id: row.created_by_id,
		basic_auth_user: row.basic_auth_user ?? '',
		created: row.created,
		updated: row.updated,
		// secret and basic_auth_password are never returned — a project admin who
		// can list webhooks would otherwise be able to read credentials another
		// admin entered, and forge signed payloads to the receiver.
	}
}

function safeEvents(raw) {
	try {
		const parsed = JSON.parse(raw ?? '[]')
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return String(raw ?? '').split(',').map(e => e.trim()).filter(Boolean)
	}
}

/** Rejects targets before they are ever called, so a bad one fails at save time. */
function validateTarget(value) {
	let url
	try {
		url = new URL(String(value ?? ''))
	} catch {
		return 'target_url must be a valid absolute URL'
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'target_url must be http or https'
	}
	// Only a literal IP can be judged here — a hostname has to be resolved, which
	// happens at send time. isBlockedAddress fails closed on anything that is not
	// an IP, so it must not see hostnames: every real domain would be rejected.
	const hostname = url.hostname.replace(/^\[|\]$/g, '')
	if (net.isIP(hostname) && isBlockedAddress(hostname)) {
		return 'target_url may not point at a private or loopback address'
	}
	return null
}

function validateEvents(value) {
	const events = Array.isArray(value) ? value : []
	if (events.length === 0) {
		return {error: 'at least one event is required'}
	}
	const unknown = events.filter(e => !WEBHOOK_EVENTS.includes(e))
	if (unknown.length > 0) {
		return {error: `unknown event(s): ${unknown.join(', ')}`}
	}
	return {events}
}

webhooksRouter.get(
	'/projects/:project(\\d+)/webhooks',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const rows = await query('SELECT * FROM webhooks WHERE project_id = ? ORDER BY id', [req.projectId])
			return res.json(rows.map(shapeWebhook))
		} catch (err) {
			return next(err)
		}
	},
)

webhooksRouter.put(
	'/projects/:project(\\d+)/webhooks',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const targetError = validateTarget(req.body?.target_url)
			if (targetError) {
				return res.status(400).json({message: targetError})
			}

			const {events, error} = validateEvents(req.body?.events)
			if (error) {
				return res.status(400).json({message: error})
			}

			// Generated rather than accepted from the client so it is always strong
			// enough to be worth verifying.
			const secret = crypto.randomBytes(32).toString('hex')

			const result = await query(
				`INSERT INTO webhooks (target_url, events, project_id, secret,
				                       basic_auth_user, basic_auth_password, created_by_id, created, updated)
				 VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[
					String(req.body.target_url), JSON.stringify(events), req.projectId, secret,
					String(req.body?.basic_auth_user ?? ''), String(req.body?.basic_auth_password ?? ''),
					req.user.id,
				],
			)

			const row = await one('SELECT * FROM webhooks WHERE id = ?', [result.insertId])
			// The only time the secret is returned: the receiver needs it to verify
			// signatures, and it is unreadable from here on.
			return res.status(201).json({...shapeWebhook(row), secret})
		} catch (err) {
			return next(err)
		}
	},
)

webhooksRouter.post(
	'/projects/:project(\\d+)/webhooks/:webhook(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const hook = await one('SELECT * FROM webhooks WHERE id = ? AND project_id = ?',
				[Number(req.params.webhook), req.projectId])
			if (!hook) {
				return res.status(404).json({message: 'webhook not found'})
			}

			const {events, error} = validateEvents(req.body?.events)
			if (error) {
				return res.status(400).json({message: error})
			}

			// Only the event list is editable. Changing target_url in place would
			// silently redirect an existing secret to a new receiver.
			await query('UPDATE webhooks SET events = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
				[JSON.stringify(events), hook.id])

			const row = await one('SELECT * FROM webhooks WHERE id = ?', [hook.id])
			return res.json(shapeWebhook(row))
		} catch (err) {
			return next(err)
		}
	},
)

webhooksRouter.delete(
	'/projects/:project(\\d+)/webhooks/:webhook(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const result = await query('DELETE FROM webhooks WHERE id = ? AND project_id = ?',
				[Number(req.params.webhook), req.projectId])
			if (result.affectedRows === 0) {
				return res.status(404).json({message: 'webhook not found'})
			}
			return res.status(204).end()
		} catch (err) {
			return next(err)
		}
	},
)
