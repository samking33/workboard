import crypto from 'node:crypto'

import bcrypt from 'bcryptjs'
import express from 'express'

import {requireAuth, requireRealUser} from '../lib/auth.js'
import {one, query} from '../lib/db.js'
import {buildCalendar, parseVTodo, taskToVTodo} from '../lib/ical.js'
import {canReadProject, canWriteProject, visibleProjectIds} from '../lib/permissions.js'
import addTaskToViews from '../lib/taskViews.js'

export const caldavRouter = express.Router()

// user_tokens.kind, matching the Go TokenKind enum.
const TOKEN_CALDAV = 4

// --- token management (called from the web UI, so JWT-authenticated) ---

export const caldavTokenRouter = express.Router()
caldavTokenRouter.use(requireAuth)
caldavTokenRouter.use(requireRealUser)

caldavTokenRouter.get('/user/settings/token/caldav', async (req, res, next) => {
	try {
		// The token itself is bcrypt-hashed and cannot be shown again.
		const rows = await query(
			'SELECT id, created FROM user_tokens WHERE user_id = ? AND kind = ? ORDER BY id DESC',
			[req.user.id, TOKEN_CALDAV],
		)
		return res.json(rows)
	} catch (err) {
		return next(err)
	}
})

caldavTokenRouter.put('/user/settings/token/caldav', async (req, res, next) => {
	try {
		const token = crypto.randomBytes(32).toString('hex')
		const hash = await bcrypt.hash(token, 11)

		const result = await query(
			'INSERT INTO user_tokens (user_id, token, kind, created) VALUES (?, ?, ?, UTC_TIMESTAMP())',
			[req.user.id, hash, TOKEN_CALDAV],
		)

		// Shown once. Stored hashed so a database read cannot recover it.
		return res.status(201).json({id: result.insertId, token, created: new Date()})
	} catch (err) {
		return next(err)
	}
})

caldavTokenRouter.delete('/user/settings/token/caldav/:id(\\d+)', async (req, res, next) => {
	try {
		const result = await query('DELETE FROM user_tokens WHERE id = ? AND user_id = ? AND kind = ?',
			[Number(req.params.id), req.user.id, TOKEN_CALDAV])
		if (result.affectedRows === 0) {
			return res.status(404).json({message: 'token not found'})
		}
		return res.status(204).end()
	} catch (err) {
		return next(err)
	}
})

// --- basic auth --------------------------------------------------------

/**
 * CalDAV clients only speak Basic auth, so this is the one place a password
 * crosses the wire on every request. Three credentials are accepted, in the
 * same order and with the same restrictions as the Go server:
 *
 *   1. a CalDAV token (preferred — scoped to calendar access only)
 *   2. an API token
 *   3. the account password, but *not* when TOTP is on: a single Basic header
 *      cannot carry a second factor, so allowing it would silently downgrade
 *      that account to one factor.
 */
async function authenticate(username, password) {
	if (!username || !password) {
		return null
	}

	const user = await one('SELECT id, username, password FROM users WHERE username = ?', [username])
	if (!user) {
		return null
	}

	const tokens = await query('SELECT token FROM user_tokens WHERE user_id = ? AND kind = ?',
		[user.id, TOKEN_CALDAV])
	for (const t of tokens) {
		if (await bcrypt.compare(password, t.token)) {
			return {id: user.id, username: user.username}
		}
	}

	if (password.startsWith('tk_')) {
		const hash = crypto.createHash('sha256').update(password).digest('hex')
		const apiToken = await one(
			'SELECT owner_id FROM api_tokens WHERE token_hash = ? AND owner_id = ? AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())',
			[hash, user.id],
		)
		return apiToken ? {id: user.id, username: user.username} : null
	}

	const totp = await one('SELECT enabled FROM totp WHERE user_id = ?', [user.id])
	if (totp?.enabled) {
		return null
	}

	return (await bcrypt.compare(password, user.password))
		? {id: user.id, username: user.username}
		: null
}

async function basicAuth(req, res, next) {
	const header = String(req.headers.authorization ?? '')
	if (!header.startsWith('Basic ')) {
		res.setHeader('WWW-Authenticate', 'Basic realm="FSOC CalDAV"')
		return res.status(401).send('authentication required')
	}

	const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
	const separator = decoded.indexOf(':')
	const username = decoded.slice(0, separator)
	const password = decoded.slice(separator + 1)

	const user = await authenticate(username, password)
	if (!user) {
		res.setHeader('WWW-Authenticate', 'Basic realm="FSOC CalDAV"')
		return res.status(401).send('invalid credentials')
	}

	req.user = user
	return next()
}

caldavRouter.use(basicAuth)

// Body arrives as XML or iCalendar, never JSON.
caldavRouter.use(express.text({type: () => true, limit: '10mb'}))

// --- helpers -----------------------------------------------------------

function xmlEscape(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function multistatus(responses) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
${responses.join('\n')}
</d:multistatus>`
}

/** A task's etag has to change whenever the task does, or clients cache stale data. */
function etagFor(task) {
	return `"${crypto.createHash('md5')
		.update(`${task.id}-${new Date(task.updated).getTime()}`)
		.digest('hex')}"`
}

function sendMultistatus(res, body) {
	res.status(207)
	res.setHeader('Content-Type', 'application/xml; charset=utf-8')
	res.setHeader('DAV', '1, 3, calendar-access')
	return res.send(body)
}

// Advertised on every response so clients know what the server supports.
caldavRouter.options('*', (req, res) => {
	res.setHeader('DAV', '1, 3, calendar-access')
	res.setHeader('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, REPORT')
	return res.status(200).end()
})

// --- principal and calendar-home discovery -----------------------------

caldavRouter.propfind(['/', '/principals/:user'], (req, res) => {
	const user = req.user.username
	return sendMultistatus(res, multistatus([
		`  <d:response>
    <d:href>/dav/principals/${xmlEscape(user)}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><d:principal/></d:resourcetype>
        <d:displayname>${xmlEscape(user)}</d:displayname>
        <d:current-user-principal><d:href>/dav/principals/${xmlEscape(user)}/</d:href></d:current-user-principal>
        <c:calendar-home-set><d:href>/dav/projects/</d:href></c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
	]))
})

/** Each project the user can read is one calendar collection. */
caldavRouter.propfind('/projects', async (req, res, next) => {
	try {
		const ids = await visibleProjectIds(req.user.id)
		const projects = ids.length > 0
			? await query(`SELECT id, title, updated FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) AND is_archived = 0`, ids)
			: []

		const responses = [
			`  <d:response>
    <d:href>/dav/projects/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:displayname>FSOC projects</d:displayname>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
		]

		for (const p of projects) {
			responses.push(`  <d:response>
    <d:href>/dav/projects/${p.id}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>${xmlEscape(p.title)}</d:displayname>
        <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
        <cs:getctag>${new Date(p.updated).getTime()}</cs:getctag>
        <d:getetag>"${new Date(p.updated).getTime()}"</d:getetag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`)
		}

		return sendMultistatus(res, multistatus(responses))
	} catch (err) {
		return next(err)
	}
})

async function tasksForProject(projectId) {
	const tasks = await query(
		'SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY `index`',
		[projectId],
	)
	for (const task of tasks) {
		task.labels = await query(
			'SELECT l.title FROM label_tasks lt JOIN labels l ON l.id = lt.label_id WHERE lt.task_id = ?',
			[task.id],
		)
	}
	return tasks
}

function taskResponse(projectId, task) {
	return `  <d:response>
    <d:href>/dav/projects/${projectId}/${task.uid || `fsoc-task-${task.id}`}.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${etagFor(task)}</d:getetag>
        <d:getcontenttype>text/calendar; component=vtodo</d:getcontenttype>
        <c:calendar-data>${xmlEscape(buildCalendar([task]))}</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`
}

caldavRouter.propfind('/projects/:project(\\d+)', async (req, res, next) => {
	try {
		const projectId = Number(req.params.project)
		if (!(await canReadProject(req.user.id, projectId))) {
			return res.status(403).send('forbidden')
		}

		const project = await one('SELECT id, title, updated FROM projects WHERE id = ?', [projectId])
		if (!project) {
			return res.status(404).send('not found')
		}

		const tasks = await tasksForProject(projectId)
		const responses = [
			`  <d:response>
    <d:href>/dav/projects/${projectId}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <d:displayname>${xmlEscape(project.title)}</d:displayname>
        <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>
        <cs:getctag>${new Date(project.updated).getTime()}</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
			...tasks.map(t => taskResponse(projectId, t)),
		]

		return sendMultistatus(res, multistatus(responses))
	} catch (err) {
		return next(err)
	}
})

// REPORT is how clients actually sync; calendar-query and multiget both land here.
caldavRouter.report('/projects/:project(\\d+)', async (req, res, next) => {
	try {
		const projectId = Number(req.params.project)
		if (!(await canReadProject(req.user.id, projectId))) {
			return res.status(403).send('forbidden')
		}

		const tasks = await tasksForProject(projectId)
		const body = String(req.body ?? '')

		// calendar-multiget names the hrefs it wants; anything else is a full query.
		const hrefs = [...body.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)].map(m => m[1])
		const wanted = hrefs.length > 0
			? tasks.filter(t => hrefs.some(h => h.endsWith(`/${t.uid || `fsoc-task-${t.id}`}.ics`)))
			: tasks

		return sendMultistatus(res, multistatus(wanted.map(t => taskResponse(projectId, t))))
	} catch (err) {
		return next(err)
	}
})

// --- individual tasks --------------------------------------------------

/** Resolves the .ics filename back to a task, scoped to the project in the path. */
async function taskForResource(projectId, resource) {
	const name = String(resource).replace(/\.ics$/i, '')
	const byId = /^fsoc-task-(\d+)$/.exec(name)

	if (byId) {
		return one('SELECT * FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL',
			[Number(byId[1]), projectId])
	}
	return one('SELECT * FROM tasks WHERE uid = ? AND project_id = ? AND deleted_at IS NULL',
		[name, projectId])
}

caldavRouter.get('/projects/:project(\\d+)/:resource', async (req, res, next) => {
	try {
		const projectId = Number(req.params.project)
		if (!(await canReadProject(req.user.id, projectId))) {
			return res.status(403).send('forbidden')
		}

		const task = await taskForResource(projectId, req.params.resource)
		if (!task) {
			return res.status(404).send('not found')
		}

		task.labels = await query(
			'SELECT l.title FROM label_tasks lt JOIN labels l ON l.id = lt.label_id WHERE lt.task_id = ?',
			[task.id],
		)

		res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
		res.setHeader('ETag', etagFor(task))
		return res.send(buildCalendar([task]))
	} catch (err) {
		return next(err)
	}
})

caldavRouter.put('/projects/:project(\\d+)/:resource', async (req, res, next) => {
	try {
		const projectId = Number(req.params.project)
		if (!(await canWriteProject(req.user.id, projectId))) {
			return res.status(403).send('forbidden')
		}

		const parsed = parseVTodo(req.body)
		if (!parsed || !parsed.title) {
			return res.status(400).send('no usable VTODO in the request')
		}

		const existing = await taskForResource(projectId, req.params.resource)

		// If-Match is how a client says "only if it has not changed since I read
		// it"; honouring it is what stops two clients silently overwriting.
		const ifMatch = req.headers['if-match']
		if (ifMatch && existing && ifMatch !== '*' && !ifMatch.includes(etagFor(existing).replace(/"/g, ''))) {
			return res.status(412).send('the task changed since you last read it')
		}
		if (req.headers['if-none-match'] === '*' && existing) {
			return res.status(412).send('that task already exists')
		}

		let taskId
		if (existing) {
			await query(
				`UPDATE tasks SET title = ?, description = ?, done = ?, done_at = ?,
				 due_date = ?, start_date = ?, priority = ?, percent_done = ?, updated = UTC_TIMESTAMP()
				 WHERE id = ?`,
				[
					parsed.title, parsed.description ?? existing.description ?? '',
					parsed.done ? 1 : 0, parsed.done ? (parsed.done_at ?? new Date()) : null,
					parsed.due_date ?? null, parsed.start_date ?? null,
					parsed.priority ?? 0, parsed.percent_done ?? 0,
					existing.id,
				],
			)
			taskId = existing.id
		} else {
			const maxRow = await one('SELECT COALESCE(MAX(`index`), 0) AS n FROM tasks WHERE project_id = ?', [projectId])
			const index = Number(maxRow.n) + 1
			// The client's UID is kept so the resource stays at the same URL.
			const uid = String(req.params.resource).replace(/\.ics$/i, '')

			const result = await query(
				`INSERT INTO tasks (title, description, project_id, done, done_at, priority,
				                    due_date, start_date, percent_done, \`index\`, uid,
				                    created_by_id, created, updated)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
				[
					parsed.title, parsed.description ?? '', projectId,
					parsed.done ? 1 : 0, parsed.done ? (parsed.done_at ?? new Date()) : null,
					parsed.priority ?? 0, parsed.due_date ?? null, parsed.start_date ?? null,
					parsed.percent_done ?? 0, index, uid, req.user.id,
				],
			)
			taskId = result.insertId

			await addTaskToViews(taskId, projectId, index, parsed.done)
		}

		const saved = await one('SELECT * FROM tasks WHERE id = ?', [taskId])
		res.setHeader('ETag', etagFor(saved))
		return res.status(existing ? 204 : 201).end()
	} catch (err) {
		return next(err)
	}
})

caldavRouter.delete('/projects/:project(\\d+)/:resource', async (req, res, next) => {
	try {
		const projectId = Number(req.params.project)
		if (!(await canWriteProject(req.user.id, projectId))) {
			return res.status(403).send('forbidden')
		}

		const task = await taskForResource(projectId, req.params.resource)
		if (!task) {
			return res.status(404).send('not found')
		}

		await query('UPDATE tasks SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [task.id])
		return res.status(204).end()
	} catch (err) {
		return next(err)
	}
})
