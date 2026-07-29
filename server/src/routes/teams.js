import express from 'express'

import {requireAuth, requireRealUser} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {shapeUser} from '../lib/shape.js'

export const teamsRouter = express.Router()
teamsRouter.use(requireAuth)
teamsRouter.use(requireRealUser)

/**
 * A team's creator is a member with admin, and only team admins may change
 * membership — otherwise anyone added to a team could add themselves to every
 * project that team can reach.
 */
async function teamRole(userId, teamId) {
	const row = await one(
		`SELECT t.id, t.created_by_id, tm.admin
		 FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
		 WHERE t.id = ?`,
		[userId, teamId],
	)
	if (!row) {
		return null
	}
	const isMember = row.admin !== null || row.created_by_id === userId
	if (!isMember) {
		return null
	}
	return {isAdmin: Boolean(row.admin) || row.created_by_id === userId}
}

async function shapeTeam(row, withMembers = false) {
	const team = {
		id: row.id,
		name: row.name,
		description: row.description ?? '',
		created_by_id: row.created_by_id,
		created: row.created,
		updated: row.updated,
	}
	if (!withMembers) {
		return team
	}

	const members = await query(
		`SELECT u.id, u.username, u.name, u.email, u.created, u.updated, tm.admin
		 FROM team_members tm JOIN users u ON u.id = tm.user_id
		 WHERE tm.team_id = ? ORDER BY u.username`,
		[row.id],
	)
	team.members = members.map(m => ({...shapeUser(m), admin: Boolean(m.admin)}))
	return team
}

teamsRouter.get('/teams', async (req, res, next) => {
	try {
		const rows = await query(
			`SELECT DISTINCT t.id, t.name, t.description, t.created_by_id, t.created, t.updated
			 FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
			 WHERE tm.user_id = ? OR t.created_by_id = ?
			 ORDER BY t.name`,
			[req.user.id, req.user.id],
		)
		res.paginate?.(rows.length, Math.max(rows.length, 1))
		return res.json(await Promise.all(rows.map(r => shapeTeam(r))))
	} catch (err) {
		return next(err)
	}
})

teamsRouter.get('/teams/:team(\\d+)', async (req, res, next) => {
	try {
		const teamId = Number(req.params.team)
		if (!(await teamRole(req.user.id, teamId))) {
			return res.status(403).json({message: 'forbidden'})
		}
		const row = await one('SELECT * FROM teams WHERE id = ?', [teamId])
		return res.json(await shapeTeam(row, true))
	} catch (err) {
		return next(err)
	}
})

teamsRouter.put('/teams', async (req, res, next) => {
	try {
		const name = String(req.body?.name ?? '').trim()
		if (!name) {
			return res.status(400).json({message: 'a name is required'})
		}

		const result = await query(
			`INSERT INTO teams (name, description, created_by_id, created, updated)
			 VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[name.slice(0, 250), String(req.body?.description ?? ''), req.user.id],
		)

		// Without this the creator is not a member of their own team and cannot
		// manage it through the normal membership checks.
		await query(
			'INSERT INTO team_members (team_id, user_id, admin, created) VALUES (?, ?, 1, UTC_TIMESTAMP())',
			[result.insertId, req.user.id],
		)

		const row = await one('SELECT * FROM teams WHERE id = ?', [result.insertId])
		return res.status(201).json(await shapeTeam(row, true))
	} catch (err) {
		return next(err)
	}
})

teamsRouter.post('/teams/:team(\\d+)', async (req, res, next) => {
	try {
		const teamId = Number(req.params.team)
		const role = await teamRole(req.user.id, teamId)
		if (!role) {
			return res.status(403).json({message: 'forbidden'})
		}
		if (!role.isAdmin) {
			return res.status(403).json({message: 'only a team admin can change the team'})
		}

		const sets = []
		const params = []
		if (req.body?.name !== undefined) {
			const name = String(req.body.name).trim()
			if (!name) {
				return res.status(400).json({message: 'a name is required'})
			}
			sets.push('name = ?')
			params.push(name.slice(0, 250))
		}
		if (req.body?.description !== undefined) {
			sets.push('description = ?')
			params.push(String(req.body.description))
		}

		if (sets.length > 0) {
			sets.push('updated = UTC_TIMESTAMP()')
			await query(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`, [...params, teamId])
		}

		const row = await one('SELECT * FROM teams WHERE id = ?', [teamId])
		return res.json(await shapeTeam(row, true))
	} catch (err) {
		return next(err)
	}
})

teamsRouter.delete('/teams/:team(\\d+)', async (req, res, next) => {
	try {
		const teamId = Number(req.params.team)
		const role = await teamRole(req.user.id, teamId)
		if (!role) {
			return res.status(403).json({message: 'forbidden'})
		}
		if (!role.isAdmin) {
			return res.status(403).json({message: 'only a team admin can delete the team'})
		}

		// The team's project shares go with it, otherwise those rows point at a
		// team that no longer exists and quietly grant nothing to nobody.
		await query('DELETE FROM team_projects WHERE team_id = ?', [teamId])
		await query('DELETE FROM team_members WHERE team_id = ?', [teamId])
		await query('DELETE FROM teams WHERE id = ?', [teamId])

		return res.json({message: 'team deleted'})
	} catch (err) {
		return next(err)
	}
})

// --- members -----------------------------------------------------------

teamsRouter.put('/teams/:team(\\d+)/members', async (req, res, next) => {
	try {
		const teamId = Number(req.params.team)
		const role = await teamRole(req.user.id, teamId)
		if (!role?.isAdmin) {
			return res.status(403).json({message: 'only a team admin can add members'})
		}

		const username = String(req.body?.username ?? '').trim()
		if (!username) {
			return res.status(400).json({message: 'a username is required'})
		}

		const user = await one('SELECT id, username, name, email, created, updated FROM users WHERE username = ?',
			[username])
		if (!user) {
			return res.status(404).json({message: 'user not found'})
		}

		await query(
			`INSERT INTO team_members (team_id, user_id, admin, created)
			 SELECT ?, ?, ?, UTC_TIMESTAMP() FROM DUAL
			 WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?)`,
			[teamId, user.id, req.body?.admin ? 1 : 0, teamId, user.id],
		)

		return res.status(201).json({...shapeUser(user), admin: Boolean(req.body?.admin)})
	} catch (err) {
		return next(err)
	}
})

teamsRouter.delete('/teams/:team(\\d+)/members/:username', async (req, res, next) => {
	try {
		const teamId = Number(req.params.team)
		const role = await teamRole(req.user.id, teamId)
		if (!role?.isAdmin) {
			return res.status(403).json({message: 'only a team admin can remove members'})
		}

		const user = await one('SELECT id FROM users WHERE username = ?', [String(req.params.username)])
		if (!user) {
			return res.status(404).json({message: 'user not found'})
		}

		// Removing the last admin would leave the team unmanageable.
		const admins = await one(
			'SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND admin = 1 AND user_id <> ?',
			[teamId, user.id],
		)
		const target = await one('SELECT admin FROM team_members WHERE team_id = ? AND user_id = ?',
			[teamId, user.id])
		if (target?.admin && Number(admins.n) === 0) {
			return res.status(400).json({message: 'that is the only admin of this team'})
		}

		await query('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, user.id])
		return res.json({message: 'member removed'})
	} catch (err) {
		return next(err)
	}
})

teamsRouter.post('/teams/:team(\\d+)/members/:username/admin', async (req, res, next) => {
	try {
		const teamId = Number(req.params.team)
		const role = await teamRole(req.user.id, teamId)
		if (!role?.isAdmin) {
			return res.status(403).json({message: 'only a team admin can change roles'})
		}

		const user = await one('SELECT id FROM users WHERE username = ?', [String(req.params.username)])
		if (!user) {
			return res.status(404).json({message: 'user not found'})
		}

		const member = await one('SELECT admin FROM team_members WHERE team_id = ? AND user_id = ?',
			[teamId, user.id])
		if (!member) {
			return res.status(404).json({message: 'that user is not in this team'})
		}

		// The client toggles rather than setting a value.
		const nowAdmin = !member.admin
		if (!nowAdmin) {
			const others = await one(
				'SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND admin = 1 AND user_id <> ?',
				[teamId, user.id],
			)
			if (Number(others.n) === 0) {
				return res.status(400).json({message: 'that is the only admin of this team'})
			}
		}

		await query('UPDATE team_members SET admin = ? WHERE team_id = ? AND user_id = ?',
			[nowAdmin ? 1 : 0, teamId, user.id])

		return res.json({admin: nowAdmin})
	} catch (err) {
		return next(err)
	}
})
