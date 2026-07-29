import {one, query} from './db.js'

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
	// Null happens for a link share, whose id is not a user id. Answering "no
	// access" here is what keeps the two number spaces from being confused.
	if (!userId) {
		return null
	}

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
			const perm = await effectivePermission(req, projectId)
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

/**
 * Highest permission on many projects at once, keyed by project id.
 *
 * One query rather than one per project: the sidebar lists every project a user
 * can reach, and the per-project version would be a round trip each.
 */
export async function permissionsForProjects(userId, projectIds) {
	const result = new Map()
	if (!userId || projectIds.length === 0) {
		return result
	}

	const ph = projectIds.map(() => '?').join(',')
	const rows = await query(
		`SELECT project_id, MAX(perm) AS perm FROM (
			SELECT id AS project_id, ? AS perm FROM projects WHERE id IN (${ph}) AND owner_id = ?
			UNION ALL
			SELECT project_id, permission AS perm FROM users_projects
				WHERE project_id IN (${ph}) AND user_id = ?
			UNION ALL
			SELECT tp.project_id, tp.permission AS perm FROM team_projects tp
				JOIN team_members tm ON tm.team_id = tp.team_id
				WHERE tp.project_id IN (${ph}) AND tm.user_id = ?
		) AS grants GROUP BY project_id`,
		[PERMISSION_ADMIN, ...projectIds, userId, ...projectIds, userId, ...projectIds, userId],
	)

	for (const r of rows) {
		result.set(r.project_id, Number(r.perm))
	}
	return result
}

/**
 * Permission for whoever made this request, user or link share.
 *
 * A link share's claims are the authority — it was granted one project at one
 * level when it was created, and no lookup can widen that.
 */
export async function effectivePermission(req, projectId) {
	if (req.linkShare) {
		return req.linkShare.projectId === projectId ? Number(req.linkShare.permission) : null
	}
	return projectPermission(req.user.id, projectId)
}

/** Project ids the caller can see at all — the basis of every list endpoint. */
export async function visibleProjectIdsFor(req) {
	if (req.linkShare) {
		return [req.linkShare.projectId]
	}
	return visibleProjectIds(req.user.id)
}

/** Project ids the user can see at all — the basis of every list endpoint. */
export async function visibleProjectIds(userId) {
	if (!userId) {
		return []
	}
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
