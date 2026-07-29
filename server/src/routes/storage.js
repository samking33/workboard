import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import express from 'express'
import multer from 'multer'

import {requireAuth} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query} from '../lib/db.js'
import {PERMISSION_READ, PERMISSION_WRITE, requireProject} from '../lib/permissions.js'
import {shapeUser} from '../lib/shape.js'
import {sniffMime} from '../lib/sniff.js'

export const storageRouter = express.Router()
storageRouter.use(requireAuth)

const KIND_DOCUMENT = 0
const KIND_LINK = 1
const KIND_IMAGE = 2
const KIND_VIDEO = 3
const KIND_NAMES = ['document', 'link', 'image', 'video']

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.heic', '.avif', '.ico'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv'])

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {fileSize: config.maxFileSizeBytes},
})

/**
 * Types safe to return with an inline Content-Disposition.
 *
 * Strict allowlist on purpose: anything served inline from our own origin runs
 * as us if the browser renders it, so text/html, XML-ish types and everything
 * unknown stay downloads.
 *
 * Only reached with a mime produced by sniffMime(), never one supplied by the
 * uploader. That sniffer identifies binary formats by magic bytes and refuses
 * anything markup-shaped, so SVG resolves to application/octet-stream and is
 * download-only here — unlike the Go server, which previewed it via <img>.
 */
function isPreviewableMime(mime) {
	const base = String(mime ?? '').split(';')[0].trim().toLowerCase()
	if (base === 'application/pdf' || base === 'text/plain') {
		return true
	}
	return base.startsWith('image/') || base.startsWith('video/') || base.startsWith('audio/')
}

/** Sorts an upload into a section. Extension wins when sniffing is inconclusive. */
function kindForFile(filename, mime) {
	const m = String(mime ?? '').toLowerCase()
	if (m.startsWith('image/')) {
		return KIND_IMAGE
	}
	if (m.startsWith('video/')) {
		return KIND_VIDEO
	}
	const ext = path.extname(filename ?? '').toLowerCase()
	if (IMAGE_EXT.has(ext)) {
		return KIND_IMAGE
	}
	if (VIDEO_EXT.has(ext)) {
		return KIND_VIDEO
	}
	return KIND_DOCUMENT
}

async function shapeItem(row) {
	let file = null
	if (row.file_id) {
		const f = await one('SELECT id, name, mime, size, created FROM files WHERE id = ?', [row.file_id])
		file = f ?? null
	}
	const createdBy = row.created_by_id
		? await one('SELECT id, username, name, email, created, updated FROM users WHERE id = ?', [row.created_by_id])
		: null

	return {
		id: row.id,
		project_id: row.project_id,
		title: row.title,
		kind: KIND_NAMES[row.kind] ?? 'document',
		url: row.url ?? '',
		file,
		created_by: shapeUser(createdBy),
		created: row.created,
		updated: row.updated,
	}
}

// Blobs are stored as <filesPath>/<file id>, matching the Go server's layout so
// files uploaded by either server resolve.
function blobPath(fileId) {
	return path.join(config.filesPath, String(fileId))
}

storageRouter.get(
	'/projects/:project/storage',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const rows = await query(
				'SELECT * FROM storage_items WHERE project_id = ? ORDER BY created DESC',
				[req.projectId],
			)
			const items = await Promise.all(rows.map(shapeItem))
			return res.json({items, total: items.length, page: 1, per_page: items.length})
		} catch (err) {
			return next(err)
		}
	},
)

storageRouter.post(
	'/projects/:project/storage',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const url = String(req.body?.url ?? '').trim()
			let parsed
			try {
				parsed = new URL(url)
			} catch {
				parsed = null
			}

			// Anything but http(s) can smuggle javascript: or data: payloads into a
			// link the whole team then clicks.
			if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
				return res.status(400).json({message: 'url must be an absolute http or https address'})
			}

			let title = String(req.body?.title ?? '').trim() || url
			title = [...title].slice(0, 250).join('')

			const result = await query(
				`INSERT INTO storage_items (project_id, title, kind, url, file_id, created_by_id, created, updated)
				 VALUES (?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[req.projectId, title, KIND_LINK, url, req.user.id],
			)

			const row = await one('SELECT * FROM storage_items WHERE id = ?', [result.insertId])
			return res.status(201).json(await shapeItem(row))
		} catch (err) {
			return next(err)
		}
	},
)

storageRouter.post(
	'/projects/:project/storage/upload',
	requireProject(PERMISSION_WRITE),
	upload.array('files'),
	async (req, res, next) => {
		try {
			const files = req.files ?? []
			const success = []
			const errors = []

			await fsp.mkdir(config.filesPath, {recursive: true})

			for (const f of files) {
				try {
					// The uploader's Content-Type decides nothing: it would let a
					// caller label an HTML payload as an image and have the preview
					// endpoint serve it inline on our origin. Derive it from bytes.
					const mime = sniffMime(f.buffer)

					const fileRow = await query(
						`INSERT INTO files (name, mime, size, created_by_id, created)
						 VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
						[f.originalname, mime, f.size, req.user.id],
					)
					await fsp.writeFile(blobPath(fileRow.insertId), f.buffer)

					const itemRow = await query(
						`INSERT INTO storage_items (project_id, title, kind, url, file_id, created_by_id, created, updated)
						 VALUES (?, ?, ?, '', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
						[
							req.projectId,
							[...f.originalname].slice(0, 250).join(''),
							kindForFile(f.originalname, mime),
							fileRow.insertId,
							req.user.id,
						],
					)

					const row = await one('SELECT * FROM storage_items WHERE id = ?', [itemRow.insertId])
					success.push(await shapeItem(row))
				} catch (err) {
					// One bad file must not discard the rest of the batch.
					errors.push(`${f.originalname}: ${err.message}`)
				}
			}

			return res.status(201).json({success, errors})
		} catch (err) {
			return next(err)
		}
	},
)

/** Loads an item scoped to the project in the path, so ids cannot be probed across projects. */
async function loadItem(projectId, itemId) {
	return one('SELECT * FROM storage_items WHERE id = ? AND project_id = ?', [itemId, projectId])
}

async function sendBlob(res, item, {inline}) {
	const file = await one('SELECT id, name, mime, size FROM files WHERE id = ?', [item.file_id])
	if (!file) {
		return res.status(404).json({message: 'file not found'})
	}

	const p = blobPath(file.id)
	if (!fs.existsSync(p)) {
		return res.status(404).json({message: 'file missing from storage'})
	}

	if (inline) {
		// Second line of defence for direct navigation to this URL. The web client
		// fetches over XHR and renders from a blob, which these headers do not
		// follow — the allowlist above is what actually protects that path.
		res.setHeader('Content-Security-Policy',
			"default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox")
	}

	res.setHeader('Content-Type', file.mime || 'application/octet-stream')
	res.setHeader('Content-Disposition',
		`${inline ? 'inline' : 'attachment'}; filename="${path.basename(file.name)}"`)
	// Never let the browser sniff a type other than the one we recorded.
	res.setHeader('X-Content-Type-Options', 'nosniff')
	res.setHeader('Cache-Control', 'no-cache')

	// sendFile handles Range, so video and audio can seek.
	return res.sendFile(path.resolve(p))
}

storageRouter.get(
	'/projects/:project/storage/:item/download',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const item = await loadItem(req.projectId, Number(req.params.item))
			if (!item) {
				return res.status(404).json({message: 'storage item not found'})
			}
			if (!item.file_id) {
				return res.status(400).json({message: 'this item is a link, it has no file to download'})
			}
			return sendBlob(res, item, {inline: false})
		} catch (err) {
			return next(err)
		}
	},
)

storageRouter.get(
	'/projects/:project/storage/:item/preview',
	requireProject(PERMISSION_READ),
	async (req, res, next) => {
		try {
			const item = await loadItem(req.projectId, Number(req.params.item))
			if (!item) {
				return res.status(404).json({message: 'storage item not found'})
			}
			if (!item.file_id) {
				return res.status(400).json({message: 'this item is a link, it has no file to preview'})
			}

			const file = await one('SELECT mime FROM files WHERE id = ?', [item.file_id])
			if (!isPreviewableMime(file?.mime)) {
				return res.status(415).json({message: 'this file type cannot be previewed. Download it instead.'})
			}
			return sendBlob(res, item, {inline: true})
		} catch (err) {
			return next(err)
		}
	},
)

storageRouter.put(
	'/projects/:project/storage/:item',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const item = await loadItem(req.projectId, Number(req.params.item))
			if (!item) {
				return res.status(404).json({message: 'storage item not found'})
			}

			const title = String(req.body?.title ?? '').trim()
			if (!title) {
				return res.status(400).json({message: 'title cannot be empty'})
			}

			// Only the title is changeable. Swapping the file or url of an existing
			// item would silently change what everyone else already saw.
			await query('UPDATE storage_items SET title = ?, updated = UTC_TIMESTAMP() WHERE id = ?',
				[[...title].slice(0, 250).join(''), item.id])

			const row = await one('SELECT * FROM storage_items WHERE id = ?', [item.id])
			return res.json(await shapeItem(row))
		} catch (err) {
			return next(err)
		}
	},
)

storageRouter.delete(
	'/projects/:project/storage/:item',
	requireProject(PERMISSION_WRITE),
	async (req, res, next) => {
		try {
			const item = await loadItem(req.projectId, Number(req.params.item))
			if (!item) {
				return res.status(404).json({message: 'storage item not found'})
			}

			await query('DELETE FROM storage_items WHERE id = ?', [item.id])

			if (item.file_id) {
				await query('DELETE FROM files WHERE id = ?', [item.file_id])
				// A missing blob is not worth failing the request over — the row is gone.
				await fsp.rm(blobPath(item.file_id), {force: true})
			}

			return res.status(204).end()
		} catch (err) {
			return next(err)
		}
	},
)
