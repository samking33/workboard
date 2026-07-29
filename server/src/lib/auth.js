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
		`SELECT id, username, email, name, password, status, is_admin, created, updated
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
		return next()
	} catch {
		return res.status(401).json({message: 'invalid or expired token'})
	}
}

/** Shape the frontend's UserModel expects from /user and login responses. */
export function publicUser(user) {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		name: user.name ?? '',
		created: user.created,
		updated: user.updated,
	}
}
