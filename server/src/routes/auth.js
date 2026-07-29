import express from 'express'

import {config} from '../lib/config.js'
import {
	findUserByLogin,
	findUserById,
	hashPassword,
	publicUser,
	requireAuth,
	signUserToken,
	verifyPassword,
} from '../lib/auth.js'
import {one, query} from '../lib/db.js'

export const authRouter = express.Router()

// Status values written by the Go server. Anything non-zero means the account
// must not be able to sign in.
const STATUS_ACTIVE = 0

authRouter.post('/login', async (req, res, next) => {
	try {
		const {username, password, long_token: longToken} = req.body ?? {}
		if (!username || !password) {
			return res.status(400).json({message: 'username and password are required'})
		}

		const user = await findUserByLogin(username)

		// Verify against a dummy hash when the user is missing so a wrong
		// username and a wrong password take the same time to answer.
		const ok = await verifyPassword(
			password,
			user?.password ?? '$2a$11$0000000000000000000000000000000000000000000000000000',
		)

		if (!user || !ok) {
			return res.status(412).json({message: 'wrong username or password'})
		}
		if (user.status !== STATUS_ACTIVE) {
			return res.status(412).json({message: 'this account is disabled'})
		}

		return res.json({token: signUserToken(user, {long: Boolean(longToken)})})
	} catch (err) {
		return next(err)
	}
})

authRouter.post('/register', async (req, res, next) => {
	try {
		if (!config.registrationEnabled) {
			return res.status(412).json({message: 'registration is disabled on this instance'})
		}

		const {username, email, password} = req.body ?? {}
		if (!username || !email || !password) {
			return res.status(400).json({message: 'username, email and password are required'})
		}

		const existing = await one(
			'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
			[username, email],
		)
		if (existing) {
			return res.status(400).json({message: 'a user with that name or email already exists'})
		}

		const hash = await hashPassword(password)
		const result = await query(
			`INSERT INTO users (username, email, password, status, is_admin, created, updated)
			 VALUES (?, ?, ?, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
			[username, email, hash],
		)

		const user = await findUserById(result.insertId)
		return res.status(201).json(publicUser(user))
	} catch (err) {
		return next(err)
	}
})

authRouter.get('/user', requireAuth, async (req, res, next) => {
	try {
		const user = await findUserById(req.user.id)
		if (!user) {
			return res.status(404).json({message: 'user not found'})
		}
		return res.json(publicUser(user))
	} catch (err) {
		return next(err)
	}
})

// The client calls this to extend a session before the token expires.
authRouter.post('/user/token', requireAuth, async (req, res, next) => {
	try {
		const user = await findUserById(req.user.id)
		if (!user || user.status !== STATUS_ACTIVE) {
			return res.status(401).json({message: 'invalid session'})
		}
		return res.json({token: signUserToken(user)})
	} catch (err) {
		return next(err)
	}
})
