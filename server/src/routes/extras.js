import crypto from 'node:crypto'

import express from 'express'
import speakeasy from 'speakeasy'

import {hashPassword, requireAuth, requireRealUser, verifyPassword} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {
	PERMISSION_ADMIN,
	PERMISSION_READ,
	PERMISSION_WRITE,
	canReadProject,
	requireProject,
} from '../lib/permissions.js'

export const extrasRouter = express.Router()
extrasRouter.use(requireAuth)
extrasRouter.use(requireRealUser)

// favorites.kind values from the Go schema.
const FAVORITE_TASK = 1
const FAVORITE_PROJECT = 2

// --- favourites --------------------------------------------------------

async function setFavorite(userId, entityId, kind, on) {
	if (on) {
		await query(
			`INSERT INTO favorites (entity_id, user_id, kind)
			 SELECT ?, ?, ? FROM DUAL
			 WHERE NOT EXISTS (SELECT 1 FROM favorites WHERE entity_id = ? AND user_id = ? AND kind = ?)`,
			[entityId, userId, kind, entityId, userId, kind],
		)
		return
	}
	await query('DELETE FROM favorites WHERE entity_id = ? AND user_id = ? AND kind = ?',
		[entityId, userId, kind])
}

extrasRouter.put('/tasks/:task(\\d+)/favorite', async (req, res, next) => {
	try {
		const task = await one('SELECT id, project_id FROM tasks WHERE id = ? AND deleted_at IS NULL',
			[Number(req.params.task)])
		if (!task || !(await canReadProject(req.user.id, task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}
		await setFavorite(req.user.id, task.id, FAVORITE_TASK, req.body?.is_favorite !== false)
		return res.json({message: 'ok'})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.put(
	'/projects/:project(\\d+)/favorite',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			await setFavorite(req.user.id, req.projectId, FAVORITE_PROJECT, req.body?.is_favorite !== false)
			return res.json({message: 'ok'})
		} catch (err) {
			return next(err)
		}
	},
)

// --- subscriptions -----------------------------------------------------

extrasRouter.put('/subscriptions/:entity/:id', async (req, res, next) => {
	try {
		const entity = String(req.params.entity)
		const entityId = Number(req.params.id)
		if (!['task', 'project'].includes(entity)) {
			return res.status(400).json({message: 'entity must be task or project'})
		}

		// Never let someone subscribe to something they cannot read.
		const projectId = entity === 'project'
			? entityId
			: (await one('SELECT project_id FROM tasks WHERE id = ?', [entityId]))?.project_id
		if (!projectId || !(await canReadProject(req.user.id, projectId))) {
			return res.status(403).json({message: 'forbidden'})
		}

		await query(
			`INSERT INTO subscriptions (entity_type, entity_id, user_id, created)
			 SELECT ?, ?, ?, UTC_TIMESTAMP() FROM DUAL
			 WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE entity_type = ? AND entity_id = ? AND user_id = ?)`,
			[entity === 'task' ? 3 : 2, entityId, req.user.id, entity === 'task' ? 3 : 2, entityId, req.user.id],
		)
		return res.status(201).json({entity, entity_id: entityId})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.delete('/subscriptions/:entity/:id', async (req, res, next) => {
	try {
		const entity = String(req.params.entity)
		await query('DELETE FROM subscriptions WHERE entity_type = ? AND entity_id = ? AND user_id = ?',
			[entity === 'task' ? 3 : 2, Number(req.params.id), req.user.id])
		return res.json({message: 'unsubscribed'})
	} catch (err) {
		return next(err)
	}
})

// --- reactions ---------------------------------------------------------

// Must match ReactionKind in the Go models — task is 0 there, not 1, so an
// off-by-one here would file a task's reactions against the comment of that id.
const REACTION_TASK = 0
const REACTION_COMMENT = 1

function reactionKind(entity) {
	return entity === 'comments' ? REACTION_COMMENT : REACTION_TASK
}

extrasRouter.get('/tasks/:task(\\d+)/:entity/:id/reactions', async (req, res, next) => {
	try {
		const rows = await query(
			`SELECT r.value, u.id, u.username, u.name, u.email, u.created, u.updated
			 FROM reactions r JOIN users u ON u.id = r.user_id
			 WHERE r.entity_id = ? AND r.entity_kind = ?`,
			[Number(req.params.id), reactionKind(req.params.entity)],
		)
		const grouped = {}
		for (const r of rows) {
			grouped[r.value] ??= []
			grouped[r.value].push({id: r.id, username: r.username, name: r.name})
		}
		return res.json(grouped)
	} catch (err) {
		return next(err)
	}
})

extrasRouter.put('/tasks/:task(\\d+)/:entity/:id/reactions', async (req, res, next) => {
	try {
		const task = await one('SELECT project_id FROM tasks WHERE id = ?', [Number(req.params.task)])
		if (!task || !(await canReadProject(req.user.id, task.project_id))) {
			return res.status(403).json({message: 'forbidden'})
		}

		const value = String(req.body?.value ?? '').slice(0, 20)
		if (!value) {
			return res.status(400).json({message: 'a value is required'})
		}

		await query(
			`INSERT INTO reactions (user_id, entity_id, entity_kind, value, created)
			 SELECT ?, ?, ?, ?, UTC_TIMESTAMP() FROM DUAL
			 WHERE NOT EXISTS (SELECT 1 FROM reactions
			                   WHERE user_id = ? AND entity_id = ? AND entity_kind = ? AND value = ?)`,
			[req.user.id, Number(req.params.id), reactionKind(req.params.entity), value,
				req.user.id, Number(req.params.id), reactionKind(req.params.entity), value],
		)
		return res.status(201).json({value})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.post('/tasks/:task(\\d+)/:entity/:id/reactions/delete', async (req, res, next) => {
	try {
		await query('DELETE FROM reactions WHERE user_id = ? AND entity_id = ? AND entity_kind = ? AND value = ?',
			[req.user.id, Number(req.params.id), reactionKind(req.params.entity), String(req.body?.value ?? '')])
		return res.json({message: 'reaction removed'})
	} catch (err) {
		return next(err)
	}
})

// --- link shares -------------------------------------------------------

extrasRouter.get(
	'/projects/:project(\\d+)/shares',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const rows = await query(
				`SELECT id, hash, name, project_id, permission, sharing_type, shared_by_id, created, updated
				 FROM link_shares WHERE project_id = ? ORDER BY created DESC`,
				[req.projectId],
			)
			// password is never returned, not even its hash.
			return res.json(rows)
		} catch (err) {
			return next(err)
		}
	},
)

extrasRouter.put(
	'/projects/:project(\\d+)/shares',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const permission = Number(req.body?.permission ?? PERMISSION_READ)
			if (![0, 1, 2].includes(permission)) {
				return res.status(400).json({message: 'permission must be 0, 1 or 2'})
			}

			const password = String(req.body?.password ?? '')
			const result = await query(
				`INSERT INTO link_shares (hash, name, project_id, permission, sharing_type, password, shared_by_id, created, updated)
				 VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[
					crypto.randomBytes(16).toString('hex'),
					String(req.body?.name ?? ''),
					req.projectId,
					permission,
					password ? 2 : 1,
					password ? await hashPassword(password) : '',
					req.user.id,
				],
			)
			const row = await one(
				'SELECT id, hash, name, project_id, permission, sharing_type, shared_by_id, created, updated FROM link_shares WHERE id = ?',
				[result.insertId],
			)
			return res.status(201).json(row)
		} catch (err) {
			return next(err)
		}
	},
)

extrasRouter.delete(
	'/projects/:project(\\d+)/shares/:share(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			await query('DELETE FROM link_shares WHERE id = ? AND project_id = ?',
				[Number(req.params.share), req.projectId])
			return res.json({message: 'share deleted'})
		} catch (err) {
			return next(err)
		}
	},
)

// --- api tokens --------------------------------------------------------

extrasRouter.get('/tokens', async (req, res, next) => {
	try {
		const rows = await query(
			'SELECT id, title, permissions, expires_at, created, token_last_eight FROM api_tokens WHERE owner_id = ? ORDER BY created DESC',
			[req.user.id],
		)
		return res.json(rows.map(r => ({
			...r,
			permissions: (() => {
				try {
					return JSON.parse(r.permissions)
				} catch {
					return {}
				}
			})(),
		})))
	} catch (err) {
		return next(err)
	}
})

extrasRouter.put('/tokens', async (req, res, next) => {
	try {
		const title = String(req.body?.title ?? '').trim()
		if (!title) {
			return res.status(400).json({message: 'a title is required'})
		}

		// The plaintext token is shown once and never stored; only a salted hash is.
		const plain = 'tk_' + crypto.randomBytes(24).toString('hex')
		const salt = crypto.randomBytes(16).toString('hex')
		const hash = crypto.createHash('sha256').update(plain + salt).digest('hex')

		const result = await query(
			`INSERT INTO api_tokens (title, token_salt, token_hash, token_last_eight, permissions, expires_at, created, owner_id)
			 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
			[
				title, salt, hash, plain.slice(-8),
				JSON.stringify(req.body?.permissions ?? {}),
				req.body?.expires_at ? new Date(req.body.expires_at) : new Date(Date.now() + 30 * 864e5),
				req.user.id,
			],
		)

		const row = await one('SELECT id, title, permissions, expires_at, created FROM api_tokens WHERE id = ?',
			[result.insertId])
		return res.status(201).json({...row, token: plain})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.delete('/tokens/:token(\\d+)', async (req, res, next) => {
	try {
		await query('DELETE FROM api_tokens WHERE id = ? AND owner_id = ?',
			[Number(req.params.token), req.user.id])
		return res.json({message: 'token deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- two factor --------------------------------------------------------

extrasRouter.get('/user/settings/totp', async (req, res, next) => {
	try {
		const row = await one('SELECT secret, enabled, url FROM totp WHERE user_id = ?', [req.user.id])
		if (!row) {
			return res.status(404).json({message: 'totp is not enabled for this user'})
		}
		return res.json({secret: row.secret, enabled: Boolean(row.enabled), url: row.url})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.post('/user/settings/totp/enroll', async (req, res, next) => {
	try {
		const user = await one('SELECT username FROM users WHERE id = ?', [req.user.id])
		const secret = speakeasy.generateSecret({name: `FSOC:${user.username}`, issuer: 'FSOC'})

		await query('DELETE FROM totp WHERE user_id = ?', [req.user.id])
		await query('INSERT INTO totp (user_id, secret, enabled, url) VALUES (?, ?, 0, ?)',
			[req.user.id, secret.base32, secret.otpauth_url])

		// enabled stays false until a code is confirmed, so a failed enrolment
		// cannot lock the user out.
		return res.json({secret: secret.base32, url: secret.otpauth_url, enabled: false})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.post('/user/settings/totp/enable', async (req, res, next) => {
	try {
		const row = await one('SELECT secret FROM totp WHERE user_id = ?', [req.user.id])
		if (!row) {
			return res.status(400).json({message: 'enroll first'})
		}

		const ok = speakeasy.totp.verify({
			secret: row.secret,
			encoding: 'base32',
			token: String(req.body?.passcode ?? ''),
			window: 1,
		})
		if (!ok) {
			return res.status(412).json({message: 'that code is not valid'})
		}

		await query('UPDATE totp SET enabled = 1 WHERE user_id = ?', [req.user.id])
		return res.json({message: 'two factor authentication enabled'})
	} catch (err) {
		return next(err)
	}
})

extrasRouter.post('/user/settings/totp/disable', async (req, res, next) => {
	try {
		// Re-authenticate before removing a second factor.
		const user = await one('SELECT password FROM users WHERE id = ?', [req.user.id])
		if (!(await verifyPassword(String(req.body?.password ?? ''), user?.password))) {
			return res.status(412).json({message: 'wrong password'})
		}
		await query('DELETE FROM totp WHERE user_id = ?', [req.user.id])
		return res.json({message: 'two factor authentication disabled'})
	} catch (err) {
		return next(err)
	}
})

// --- project actions ---------------------------------------------------

extrasRouter.post(
	'/projects/:project(\\d+)/archive',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const archived = req.body?.is_archived !== false
			await query('UPDATE projects SET is_archived = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
				[archived ? 1 : 0, req.projectId])
			const row = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			return res.json({...row, is_archived: Boolean(row.is_archived)})
		} catch (err) {
			return next(err)
		}
	},
)

extrasRouter.put(
	'/projects/:project(\\d+)/duplicate',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const source = await one('SELECT * FROM projects WHERE id = ?', [req.projectId])
			const result = await query(
				`INSERT INTO projects (title, description, owner_id, parent_project_id, is_archived, position, created, updated)
				 VALUES (?, ?, ?, ?, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[`${source.title} - duplicate`, source.description ?? '', req.user.id,
					req.body?.parent_project_id || null],
			)
			const newId = result.insertId

			// Views first: tasks reference them for buckets and positions.
			const views = await query('SELECT * FROM project_views WHERE project_id = ? ORDER BY position', [req.projectId])
			for (const v of views) {
				await query(
					`INSERT INTO project_views (title, project_id, view_kind, filter, position,
					                            bucket_configuration_mode, bucket_configuration, created, updated)
					 VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
					[v.title, newId, v.view_kind, v.filter, v.position, v.bucket_configuration_mode, v.bucket_configuration],
				)
			}

			const tasks = await query('SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL', [req.projectId])
			for (const t of tasks) {
				await query(
					`INSERT INTO tasks (title, description, project_id, done, priority, due_date, start_date,
					                    end_date, percent_done, hex_color, \`index\`, created_by_id, created, updated)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
					[t.title, t.description, newId, t.done, t.priority, t.due_date, t.start_date,
						t.end_date, t.percent_done, t.hex_color, t.index, req.user.id],
				)
			}

			const row = await one('SELECT * FROM projects WHERE id = ?', [newId])
			return res.status(201).json({project: row})
		} catch (err) {
			return next(err)
		}
	},
)

// --- bulk task edit ----------------------------------------------------

extrasRouter.post('/tasks/bulk', async (req, res, next) => {
	try {
		const ids = (req.body?.task_ids ?? []).map(Number).filter(Number.isInteger)
		if (ids.length === 0) {
			return res.status(400).json({message: 'task_ids is required'})
		}

		// Every task is checked individually — a bulk call must not become a way
		// to reach one the caller has no write access to.
		for (const id of ids) {
			const t = await one('SELECT project_id FROM tasks WHERE id = ? AND deleted_at IS NULL', [id])
			if (!t) {
				return res.status(404).json({message: `task ${id} not found`})
			}
			const {canWriteProject} = await import('../lib/permissions.js')
			if (!(await canWriteProject(req.user.id, t.project_id))) {
				return res.status(403).json({message: `forbidden on task ${id}`})
			}
		}

		const sets = []
		const params = []
		for (const field of ['done', 'priority', 'percent_done', 'due_date']) {
			if (req.body?.[field] === undefined) {
				continue
			}
			let value = req.body[field]
			if (field === 'due_date') {
				value = value ? new Date(value) : null
			}
			if (field === 'done') {
				value = value ? 1 : 0
			}
			sets.push(`\`${field}\` = ?`)
			params.push(value)
		}
		if (sets.length === 0) {
			return res.status(400).json({message: 'nothing to update'})
		}

		const ph = ids.map(() => '?').join(',')
		await query(`UPDATE tasks SET ${sets.join(', ')}, updated = UTC_TIMESTAMP() WHERE id IN (${ph})`,
			[...params, ...ids])
		return res.json({message: `${ids.length} tasks updated`})
	} catch (err) {
		return next(err)
	}
})
