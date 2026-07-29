import express from 'express'

import {requireAuth, requireRealUser} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {PERMISSION_ADMIN, PERMISSION_READ, requireProject} from '../lib/permissions.js'
import {shapeUser} from '../lib/shape.js'

export const sharingRouter = express.Router()
sharingRouter.use(requireAuth)
sharingRouter.use(requireRealUser)

// --- who can reach a project ------------------------------------------

sharingRouter.get(
	'/projects/:project(\\d+)/users',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const rows = await query(
				`SELECT u.id, u.username, u.name, u.email, u.created, u.updated, up.permission
				 FROM users_projects up JOIN users u ON u.id = up.user_id
				 WHERE up.project_id = ? ORDER BY u.username`,
				[req.projectId],
			)
			return res.json(rows.map(r => ({...shapeUser(r), permission: r.permission})))
		} catch (err) {
			return next(err)
		}
	},
)

// Only admins may change who has access — anything less and a member could
// grant themselves more, or quietly add someone.
sharingRouter.put(
	'/projects/:project(\\d+)/users',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const username = String(req.body?.username ?? '').trim()
			const permission = Number(req.body?.permission ?? PERMISSION_READ)
			if (!username) {
				return res.status(400).json({message: 'username is required'})
			}
			if (![0, 1, 2].includes(permission)) {
				return res.status(400).json({message: 'permission must be 0, 1 or 2'})
			}

			const user = await one('SELECT id, username FROM users WHERE username = ?', [username])
			if (!user) {
				return res.status(404).json({message: 'user not found'})
			}

			const owner = await one('SELECT owner_id FROM projects WHERE id = ?', [req.projectId])
			if (owner?.owner_id === user.id) {
				return res.status(400).json({message: 'the owner already has full access'})
			}

			await query(
				`INSERT INTO users_projects (user_id, project_id, permission, created, updated)
				 VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
				 ON DUPLICATE KEY UPDATE permission = VALUES(permission), updated = UTC_TIMESTAMP()`,
				[user.id, req.projectId, permission],
			)
			return res.status(201).json({username: user.username, permission})
		} catch (err) {
			return next(err)
		}
	},
)

sharingRouter.post(
	'/projects/:project(\\d+)/users/:user(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const permission = Number(req.body?.permission)
			if (![0, 1, 2].includes(permission)) {
				return res.status(400).json({message: 'permission must be 0, 1 or 2'})
			}

			const user = await one('SELECT id FROM users WHERE username = ? OR id = ?',
				[req.params.user, Number(req.params.user) || 0])
			if (!user) {
				return res.status(404).json({message: 'user not found'})
			}

			await query(
				'UPDATE users_projects SET permission = ?, updated = UTC_TIMESTAMP() WHERE project_id = ? AND user_id = ?',
				[permission, req.projectId, user.id],
			)
			return res.json({permission})
		} catch (err) {
			return next(err)
		}
	},
)

sharingRouter.delete(
	'/projects/:project(\\d+)/users/:user(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const user = await one('SELECT id FROM users WHERE username = ? OR id = ?',
				[req.params.user, Number(req.params.user) || 0])
			if (!user) {
				return res.status(404).json({message: 'user not found'})
			}

			await query('DELETE FROM users_projects WHERE project_id = ? AND user_id = ?',
				[req.projectId, user.id])
			return res.json({message: 'access removed'})
		} catch (err) {
			return next(err)
		}
	},
)

// --- teams on a project -----------------------------------------------

sharingRouter.get(
	'/projects/:project(\\d+)/teams',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const rows = await query(
				`SELECT t.id, t.name, t.description, tp.permission, t.created, t.updated
				 FROM team_projects tp JOIN teams t ON t.id = tp.team_id
				 WHERE tp.project_id = ? ORDER BY t.name`,
				[req.projectId],
			)
			return res.json({items: rows, total: rows.length, page: 1, per_page: rows.length})
		} catch (err) {
			return next(err)
		}
	},
)

sharingRouter.put(
	'/projects/:project(\\d+)/teams',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			const teamId = Number(req.body?.team_id)
			const permission = Number(req.body?.permission ?? PERMISSION_READ)
			if (!Number.isInteger(teamId)) {
				return res.status(400).json({message: 'team_id is required'})
			}

			await query(
				`INSERT INTO team_projects (team_id, project_id, permission, created, updated)
				 VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
				 ON DUPLICATE KEY UPDATE permission = VALUES(permission), updated = UTC_TIMESTAMP()`,
				[teamId, req.projectId, permission],
			)
			return res.status(201).json({team_id: teamId, permission})
		} catch (err) {
			return next(err)
		}
	},
)

sharingRouter.delete(
	'/projects/:project(\\d+)/teams/:team(\\d+)',
	requireProject(PERMISSION_ADMIN),
	async (req, res, next) => {
		try {
			await query('DELETE FROM team_projects WHERE project_id = ? AND team_id = ?',
				[req.projectId, Number(req.params.team)])
			return res.status(204).end()
		} catch (err) {
			return next(err)
		}
	},
)

// --- user search (needed by the share dialog) -------------------------

sharingRouter.get('/users', async (req, res, next) => {
	try {
		const search = String(req.query.s ?? '').trim()
		if (!search) {
			return res.json([])
		}
		const rows = await query(
			`SELECT id, username, name, email, created, updated FROM users
			 WHERE username LIKE ? OR name LIKE ? ORDER BY username LIMIT 25`,
			[`%${search}%`, `%${search}%`],
		)
		return res.json(rows.map(shapeUser))
	} catch (err) {
		return next(err)
	}
})
