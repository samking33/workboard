import crypto from 'node:crypto'

import bcrypt from 'bcryptjs'
import express from 'express'

import {signLinkShareToken} from '../lib/auth.js'
import {one} from '../lib/db.js'

/**
 * Exchanges a share hash for a scoped token. Deliberately unauthenticated —
 * holding the link is the credential — so it is mounted before requireAuth.
 */
export const linkShareAuthRouter = express.Router()

// Nothing here reveals whether a hash exists: an unknown hash and a wrong
// password produce the same answer, so the endpoint cannot be used to
// enumerate valid share links.
const GENERIC_ERROR = {message: 'this link is not valid, or the password is wrong'}

// Cost-11 hash of a value nobody will submit. Compared against when the hash is
// unknown so a missing share takes the same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 11)

linkShareAuthRouter.post('/shares/:hash/auth', async (req, res, next) => {
	try {
		const hash = String(req.params.hash ?? '').trim()
		if (!hash) {
			return res.status(400).json(GENERIC_ERROR)
		}

		const share = await one(
			'SELECT id, hash, project_id, permission, sharing_type, password FROM link_shares WHERE hash = ?',
			[hash],
		)

		// sharing_type 2 means the share carries a password.
		const needsPassword = share ? Number(share.sharing_type) === 2 : true
		const supplied = String(req.body?.password ?? '')

		if (needsPassword) {
			const against = share?.password || DUMMY_HASH
			const ok = await bcrypt.compare(supplied, against)
			if (!share || !ok) {
				return res.status(401).json(GENERIC_ERROR)
			}
		} else if (!share) {
			return res.status(401).json(GENERIC_ERROR)
		}

		return res.json({token: signLinkShareToken(share)})
	} catch (err) {
		return next(err)
	}
})
