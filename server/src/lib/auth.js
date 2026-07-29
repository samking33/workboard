import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

import {config} from './config.js'
import {one} from './db.js'

// Mirrors the Go server's token `type` claim. The frontend reads it to tell a
// real user session from a link share.
export const AUTH_TYPE_USER = 1
export const AUTH_TYPE_LINK_SHARE = 2

/**
 * Builds the token the Vue client expects. The claim set is deliberately the
 * same as the Go server's — the frontend decodes it directly and reads
 * id/username/exp/is_admin, so anything missing breaks the session silently.
 */
export function signUserToken(user, {long = false} = {}) {
	const ttl = long ? 60 * 60 * 24 * 30 : config.tokenTtlSeconds
	return jwt.sign(
		{
			type: AUTH_TYPE_USER,
			id: user.id,
			username: user.username,
			is_admin: Boolean(user.is_admin),
			// jti/sid exist so a token can be tied to a session row later.
			jti: crypto.randomUUID(),
			sid: crypto.randomUUID(),
		},
		config.secret,
		{expiresIn: ttl},
	)
}

/**
 * A link share is not a user. Its token carries the one project it opens and
 * the permission it was created with, so possession of the link can never
 * reach anything else — the permission layer reads these claims rather than
 * looking the holder up in users_projects.
 */
export function signLinkShareToken(share) {
	return jwt.sign(
		{
			type: AUTH_TYPE_LINK_SHARE,
			id: share.id,
			hash: share.hash,
			project_id: share.project_id,
			permission: share.permission,
			username: `link-share-${share.id}`,
			jti: crypto.randomUUID(),
		},
		config.secret,
		{expiresIn: config.tokenTtlSeconds},
	)
}

/**
 * Refresh tokens live in an HttpOnly cookie, not in JS-readable storage, so a
 * script on the page cannot exfiltrate one. They only ever mint access tokens.
 */
export const REFRESH_COOKIE = 'fsoc_refresh'
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30

export function signRefreshToken(user) {
	return jwt.sign({typ: 'refresh', id: user.id}, config.secret, {expiresIn: REFRESH_TTL_SECONDS})
}

export function setRefreshCookie(res, user, {secure}) {
	res.cookie(REFRESH_COOKIE, signRefreshToken(user), {
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: REFRESH_TTL_SECONDS * 1000,
		path: '/api',
	})
}

export function clearRefreshCookie(res) {
	res.clearCookie(REFRESH_COOKIE, {path: '/api'})
}

export function readRefreshToken(req) {
	const raw = req.cookies?.[REFRESH_COOKIE]
	if (!raw) {
		return null
	}
	try {
		const claims = jwt.verify(raw, config.secret)
		// An access token must never be accepted here, or a stolen one would
		// grant indefinite renewal.
		return claims.typ === 'refresh' ? claims : null
	} catch {
		return null
	}
}

/**
 * Existing passwords are bcrypt ($2a$) written by the Go server. bcryptjs reads
 * that format, so every account keeps working without a reset.
 */
export async function verifyPassword(plain, hash) {
	if (!hash) {
		return false
	}
	return bcrypt.compare(plain, hash)
}

export async function hashPassword(plain) {
	// Cost 11 matches the existing rows, so hashes stay uniform.
	return bcrypt.hash(plain, 11)
}

export async function findUserByLogin(login) {
	return one(
		`SELECT id, username, email, name, password, status, is_admin, bot_owner_id, created, updated
		 FROM users WHERE username = ? OR email = ? LIMIT 1`,
		[login, login],
	)
}

export async function findUserById(id) {
	return one(
		`SELECT id, username, email, name, status, is_admin, created, updated
		 FROM users WHERE id = ? LIMIT 1`,
		[id],
	)
}

/** Express middleware: requires a valid bearer token, attaches req.user. */
export function requireAuth(req, res, next) {
	const header = req.get('authorization') ?? ''
	if (!header.startsWith('Bearer ')) {
		return res.status(401).json({message: 'missing or malformed authorization header'})
	}

	try {
		const claims = jwt.verify(header.slice(7), config.secret)
		req.user = {
			id: claims.id,
			username: claims.username,
			isAdmin: Boolean(claims.is_admin),
			type: claims.type,
		}

		// A link share is scoped to one project at one permission.
		//
		// Its id is a link_shares row id, which shares a number space with user
		// ids — share 1 and user 1 are different things. So req.user.id is blanked
		// here: any helper that takes a user id (canReadProject and friends) then
		// resolves to no access rather than silently answering as whichever user
		// happens to hold that id. Routes that mean to serve a share read
		// req.linkShare explicitly, so support is opt-in per route.
		if (claims.type === AUTH_TYPE_LINK_SHARE) {
			req.linkShare = {
				id: claims.id,
				projectId: claims.project_id,
				permission: claims.permission,
			}
			req.user.id = null
			req.user.isAdmin = false
		}

		return next()
	} catch {
		return res.status(401).json({message: 'invalid or expired token'})
	}
}

/**
 * Refuses link-share tokens.
 *
 * A share is not an account: it has no settings, no email, and nothing it could
 * own. Without this those routes fail somewhere deeper — creating a project as a
 * share hit a null owner_id and produced a 500 rather than a refusal.
 */
export function requireRealUser(req, res, next) {
	if (req.linkShare) {
		return res.status(403).json({message: 'a share link cannot do this'})
	}
	return next()
}

/** Shape the frontend's UserModel expects from /user and login responses. */
export function publicUser(user) {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		name: user.name ?? '',
		// The client's admin-route guard reads this from /user rather than from
		// the token, so leaving it out hides the admin panel from real admins.
		is_admin: Boolean(user.is_admin),
		created: user.created,
		updated: user.updated,
	}
}
