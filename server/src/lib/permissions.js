import {one} from './db.js'

export const PERMISSION_READ = 0
export const PERMISSION_WRITE = 1
export const PERMISSION_ADMIN = 2

/**
 * Highest permission a user has on a project, or null if none.
 *
 * A project is reachable three ways: you own it, it is shared with you
 * directly, or it is shared with a team you belong to. The strongest of those
 * wins. Returning null (rather than READ) is deliberate — callers must not be
 * able to mistake "no access" for "read access".
 */
export async function projectPermission(userId, projectId) {
	const row = await one(
		`SELECT MAX(perm) AS perm FROM (
			SELECT ? AS perm FROM projects WHERE id = ? AND owner_id = ?
			UNION ALL
			SELECT up.permission FROM users_projects up
				WHERE up.project_id = ? AND up.user_id = ?
			UNION ALL
			SELECT tp.permission FROM team_projects tp
				JOIN team_members tm ON tm.team_id = tp.team_id
				WHERE tp.project_id = ? AND tm.user_id = ?
		) AS grants`,
		[PERMISSION_ADMIN, projectId, userId, projectId, userId, projectId, userId],
	)

	return row?.perm === null || row?.perm === undefined ? null : Number(row.perm)
}

export async function canReadProject(userId, projectId) {
	return (await projectPermission(userId, projectId)) !== null
}

export async function canWriteProject(userId, projectId) {
	const perm = await projectPermission(userId, projectId)
	return perm !== null && perm >= PERMISSION_WRITE
}

export async function canAdminProject(userId, projectId) {
	const perm = await projectPermission(userId, projectId)
	return perm !== null && perm >= PERMISSION_ADMIN
}

/**
 * Express middleware factory guarding a route by project permission.
 * Reads the project id from req.params[param].
 *
 * Denies with 403 rather than 404 to match the Go server's responses, which the
 * frontend already handles.
 */
export function requireProject(level, param = 'project') {
	return async (req, res, next) => {
		const projectId = Number(req.params[param])
		if (!Number.isInteger(projectId)) {
			return res.status(400).json({message: 'invalid project id'})
		}

		try {
			const perm = await projectPermission(req.user.id, projectId)
			if (perm === null || perm < level) {
				return res.status(403).json({message: 'forbidden'})
			}
			req.projectPermission = perm
			req.projectId = projectId
			return next()
		} catch (err) {
			return next(err)
		}
	}
}

/** Project ids the user can see at all — the basis of every list endpoint. */
export async function visibleProjectIds(userId) {
	const rows = await one(
		`SELECT GROUP_CONCAT(DISTINCT id) AS ids FROM (
			SELECT id FROM projects WHERE owner_id = ?
			UNION
			SELECT project_id AS id FROM users_projects WHERE user_id = ?
			UNION
			SELECT tp.project_id AS id FROM team_projects tp
				JOIN team_members tm ON tm.team_id = tp.team_id
				WHERE tm.user_id = ?
		) AS reachable`,
		[userId, userId, userId],
	)

	if (!rows?.ids) {
		return []
	}
	return rows.ids.split(',').map(Number)
}
