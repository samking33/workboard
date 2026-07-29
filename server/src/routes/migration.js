import express from 'express'
import multer from 'multer'
import AdmZip from 'adm-zip'

import {requireAuth} from '../lib/auth.js'
import {config} from '../lib/config.js'
import {one, query} from '../lib/db.js'
import {detectDelimiter, parseCsv, parseDate, suggestMapping} from '../lib/csv.js'
import addTaskToViews from '../lib/taskViews.js'

import {createDefaultViews} from './projects.js'

export const migrationRouter = express.Router()
migrationRouter.use(requireAuth)

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {fileSize: config.maxFileSizeBytes},
})

// Only file-based migrators. Todoist and Microsoft Todo need OAuth apps
// registered with those services, which an instance cannot do on its own.
export const FILE_MIGRATORS = ['vikunja-file', 'csv', 'trello', 'ticktick', 'wekan']

// --- status ------------------------------------------------------------

async function markStarted(userId, migrator) {
	const result = await query(
		'INSERT INTO migration_status (user_id, migrator_name, started_at) VALUES (?, ?, UTC_TIMESTAMP())',
		[userId, migrator],
	)
	return result.insertId
}

async function markFinished(id) {
	await query('UPDATE migration_status SET finished_at = UTC_TIMESTAMP() WHERE id = ?', [id])
}

migrationRouter.get('/migration/:migrator/status', async (req, res, next) => {
	try {
		const row = await one(
			'SELECT started_at, finished_at FROM migration_status WHERE user_id = ? AND migrator_name = ? ORDER BY id DESC LIMIT 1',
			[req.user.id, String(req.params.migrator)],
		)
		return res.json({
			started_at: row?.started_at ?? null,
			finished_at: row?.finished_at ?? null,
		})
	} catch (err) {
		return next(err)
	}
})

// --- shared import primitives -----------------------------------------

async function createProject(userId, title, description = '') {
	const result = await query(
		`INSERT INTO projects (title, description, identifier, hex_color, owner_id,
		                       parent_project_id, is_archived, position, created, updated)
		 VALUES (?, ?, '', '', ?, NULL, 0, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
		[String(title || 'Imported project').slice(0, 250), String(description ?? '').slice(0, 65000), userId],
	)
	await createDefaultViews(result.insertId, userId)
	return result.insertId
}

/** Reuses a label of the same name rather than creating a duplicate per task. */
async function labelId(userId, title, cache) {
	const key = String(title).trim().toLowerCase()
	if (!key) {
		return null
	}
	if (cache.has(key)) {
		return cache.get(key)
	}

	const existing = await one('SELECT id FROM labels WHERE created_by_id = ? AND LOWER(title) = ?', [userId, key])
	if (existing) {
		cache.set(key, existing.id)
		return existing.id
	}

	const result = await query(
		'INSERT INTO labels (title, description, hex_color, created_by_id, created, updated) VALUES (?, \'\', \'\', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
		[String(title).trim().slice(0, 250), userId],
	)
	cache.set(key, result.insertId)
	return result.insertId
}

async function createTask(userId, projectId, task, index, labelCache) {
	const result = await query(
		`INSERT INTO tasks (title, description, project_id, done, done_at, priority,
		                    due_date, start_date, end_date, percent_done, \`index\`,
		                    created_by_id, created, updated)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
		[
			String(task.title || 'Untitled').slice(0, 250),
			String(task.description ?? '').slice(0, 65000),
			projectId,
			task.done ? 1 : 0,
			task.done ? new Date() : null,
			Number(task.priority) || 0,
			task.due_date ?? null,
			task.start_date ?? null,
			task.end_date ?? null,
			Number(task.percent_done) || 0,
			index,
			userId,
		],
	)

	const taskId = result.insertId

	for (const label of task.labels ?? []) {
		const id = await labelId(userId, label, labelCache)
		if (id) {
			await query('INSERT IGNORE INTO label_tasks (task_id, label_id, created) VALUES (?, ?, UTC_TIMESTAMP())',
				[taskId, id])
		}
	}

	for (const reminder of task.reminders ?? []) {
		if (reminder) {
			await query('INSERT INTO task_reminders (task_id, reminder, created) VALUES (?, ?, UTC_TIMESTAMP())',
				[taskId, reminder])
		}
	}

	await addTaskToViews(taskId, projectId, index, task.done)

	return taskId
}

/** Writes a whole parsed import. Shared by every migrator. */
async function importProjects(userId, projects, migratorName) {
	const statusId = await markStarted(userId, migratorName)
	const labelCache = new Map()
	let taskCount = 0

	for (const project of projects) {
		const projectId = await createProject(userId, project.title, project.description)

		let index = 0
		for (const task of project.tasks ?? []) {
			index++
			const taskId = await createTask(userId, projectId, task, index, labelCache)
			taskCount++

			for (const comment of task.comments ?? []) {
				const text = typeof comment === 'string' ? comment : comment?.comment
				if (text) {
					await query(
						'INSERT INTO task_comments (comment, author_id, task_id, created, updated) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
						[String(text).slice(0, 65000), userId, taskId],
					)
				}
			}
		}
	}

	await markFinished(statusId)
	return {projects: projects.length, tasks: taskCount}
}

// --- CSV ---------------------------------------------------------------

function readUpload(req) {
	const file = req.file ?? (req.files ?? [])[0]
	if (!file) {
		return null
	}
	return file.buffer
}

migrationRouter.post('/migration/csv/detect', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}

		const text = buffer.toString('utf8')
		const delimiter = detectDelimiter(text)
		const rows = parseCsv(text, {delimiter}).filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
		if (rows.length === 0) {
			return res.status(400).json({message: 'that file has no rows'})
		}

		const columns = rows[0]
		return res.json({
			columns,
			delimiter,
			quote_char: '"',
			date_format: '2006-01-02',
			suggested_mapping: suggestMapping(columns),
			preview_rows: rows.slice(1, 6),
		})
	} catch (err) {
		return next(err)
	}
})

/** Turns rows plus a column mapping into task objects. */
function rowsToTasks(rows, cfg) {
	const mapping = Array.isArray(cfg.mapping) ? cfg.mapping : []
	const dateFormat = cfg.date_format || '2006-01-02'
	const skip = Number(cfg.skip_rows ?? 1)

	const byAttribute = new Map()
	for (const m of mapping) {
		if (m.attribute && m.attribute !== 'ignore') {
			byAttribute.set(m.attribute, Number(m.column_index))
		}
	}

	const cell = (row, attr) => {
		const i = byAttribute.get(attr)
		return i === undefined ? '' : String(row[i] ?? '').trim()
	}

	const tasks = []
	for (const row of rows.slice(skip)) {
		// A row that is entirely empty is padding at the end of the file.
		if (row.every(c => String(c ?? '').trim() === '')) {
			continue
		}

		const doneCell = cell(row, 'done').toLowerCase()
		const labels = cell(row, 'labels')
		const reminder = parseDate(cell(row, 'reminder'), dateFormat)

		tasks.push({
			title: cell(row, 'title') || 'Untitled',
			description: cell(row, 'description'),
			done: ['true', '1', 'yes', 'y', 'done', 'completed', 'x'].includes(doneCell),
			priority: Number(cell(row, 'priority')) || 0,
			due_date: parseDate(cell(row, 'due_date'), dateFormat),
			start_date: parseDate(cell(row, 'start_date'), dateFormat),
			end_date: parseDate(cell(row, 'end_date'), dateFormat),
			labels: labels ? labels.split(/[,;|]/).map(l => l.trim()).filter(Boolean) : [],
			reminders: reminder ? [reminder] : [],
			project: cell(row, 'project'),
		})
	}

	return tasks
}

function parseConfig(req) {
	try {
		return JSON.parse(req.body?.config ?? '{}')
	} catch {
		return null
	}
}

migrationRouter.post('/migration/csv/preview', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		const cfg = parseConfig(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}
		if (!cfg) {
			return res.status(400).json({message: 'the import configuration is not valid JSON'})
		}

		const rows = parseCsv(buffer.toString('utf8'), {
			delimiter: cfg.delimiter || ',',
			quoteChar: cfg.quote_char || '"',
		})
		const tasks = rowsToTasks(rows, cfg)

		return res.json({
			tasks: tasks.slice(0, 25).map(t => ({
				...t,
				due_date: t.due_date?.toISOString() ?? null,
				start_date: t.start_date?.toISOString() ?? null,
				end_date: t.end_date?.toISOString() ?? null,
			})),
			total_rows: tasks.length,
		})
	} catch (err) {
		return next(err)
	}
})

migrationRouter.post('/migration/csv/migrate', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		const cfg = parseConfig(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}
		if (!cfg) {
			return res.status(400).json({message: 'the import configuration is not valid JSON'})
		}

		const rows = parseCsv(buffer.toString('utf8'), {
			delimiter: cfg.delimiter || ',',
			quoteChar: cfg.quote_char || '"',
		})
		const tasks = rowsToTasks(rows, cfg)
		if (tasks.length === 0) {
			return res.status(400).json({message: 'no tasks were found in that file'})
		}

		// A `project` column splits the import into several projects; without one
		// everything lands in a single project named after the file.
		const grouped = new Map()
		for (const task of tasks) {
			const name = task.project || 'Imported from CSV'
			if (!grouped.has(name)) {
				grouped.set(name, [])
			}
			grouped.get(name).push(task)
		}

		const result = await importProjects(
			req.user.id,
			[...grouped].map(([title, projectTasks]) => ({title, tasks: projectTasks})),
			'csv',
		)

		return res.json({message: `imported ${result.tasks} task(s) into ${result.projects} project(s)`})
	} catch (err) {
		return next(err)
	}
})

// --- Vikunja / FSOC export file ---------------------------------------

migrationRouter.post('/migration/vikunja-file/migrate', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}

		let doc
		// Accepts both our own gzipped JSON export and the upstream zip.
		if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
			const zip = new AdmZip(buffer)
			const entry = zip.getEntries().find(e => /data\.json$|\.json$/i.test(e.entryName) && !e.isDirectory)
			if (!entry) {
				return res.status(400).json({message: 'that archive has no JSON data file in it'})
			}
			doc = JSON.parse(entry.getData().toString('utf8'))
		} else if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
			const zlib = await import('node:zlib')
			doc = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
		} else {
			doc = JSON.parse(buffer.toString('utf8'))
		}

		const source = Array.isArray(doc) ? doc : (doc.projects ?? [])
		if (source.length === 0) {
			return res.status(400).json({message: 'no projects were found in that file'})
		}

		const projects = source.map(p => ({
			title: p.title,
			description: p.description,
			tasks: (p.tasks ?? []).map(t => ({
				title: t.title,
				description: t.description,
				done: Boolean(t.done),
				priority: t.priority,
				percent_done: t.percent_done,
				due_date: usableDate(t.due_date),
				start_date: usableDate(t.start_date),
				end_date: usableDate(t.end_date),
				labels: (t.labels ?? []).map(l => (typeof l === 'string' ? l : l.title)).filter(Boolean),
				reminders: (t.reminders ?? []).map(r => usableDate(r?.reminder ?? r)).filter(Boolean),
				comments: t.comments ?? [],
			})),
		}))

		const result = await importProjects(req.user.id, projects, 'vikunja-file')
		return res.json({message: `imported ${result.tasks} task(s) into ${result.projects} project(s)`})
	} catch (err) {
		if (err instanceof SyntaxError) {
			return res.status(400).json({message: 'that file is not a valid export'})
		}
		return next(err)
	}
})

/** Go writes unset times as year 1, which must not become a real due date. */
function usableDate(value) {
	if (!value) {
		return null
	}
	const date = new Date(value)
	if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1970) {
		return null
	}
	return date
}

// --- Trello board export ----------------------------------------------

migrationRouter.post('/migration/trello/migrate', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}

		const boards = [].concat(JSON.parse(buffer.toString('utf8')))
		const projects = []

		for (const board of boards) {
			// Trello keeps cards flat with a list id; the list becomes a label so the
			// column a card sat in is not lost.
			const listNames = new Map((board.lists ?? []).map(l => [l.id, l.name]))
			const labelNames = new Map((board.labels ?? []).map(l => [l.id, l.name || l.color]))
			const commentsByCard = new Map()

			for (const action of board.actions ?? []) {
				if (action.type !== 'commentCard') {
					continue
				}
				const cardId = action.data?.card?.id
				if (!cardId) {
					continue
				}
				if (!commentsByCard.has(cardId)) {
					commentsByCard.set(cardId, [])
				}
				commentsByCard.get(cardId).push(action.data.text)
			}

			projects.push({
				title: board.name || 'Trello board',
				description: board.desc ?? '',
				tasks: (board.cards ?? [])
					.filter(card => !card.closed)
					.map(card => ({
						title: card.name,
						description: card.desc,
						done: Boolean(card.dueComplete),
						due_date: usableDate(card.due),
						start_date: usableDate(card.start),
						labels: [
							listNames.get(card.idList),
							...(card.idLabels ?? []).map(id => labelNames.get(id)),
						].filter(Boolean),
						comments: commentsByCard.get(card.id) ?? [],
					})),
			})
		}

		if (projects.length === 0) {
			return res.status(400).json({message: 'no boards were found in that file'})
		}

		const result = await importProjects(req.user.id, projects, 'trello')
		return res.json({message: `imported ${result.tasks} card(s) from ${result.projects} board(s)`})
	} catch (err) {
		if (err instanceof SyntaxError) {
			return res.status(400).json({message: 'that file is not a valid Trello board export'})
		}
		return next(err)
	}
})

// --- TickTick (CSV with a fixed header) --------------------------------

migrationRouter.post('/migration/ticktick/migrate', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}

		const text = buffer.toString('utf8')
		// TickTick puts several comment lines before the real header.
		const lines = text.split(/\r?\n/)
		const headerIndex = lines.findIndex(l => /(^|,)"?Title"?(,|$)/i.test(l))
		if (headerIndex === -1) {
			return res.status(400).json({message: 'that file does not look like a TickTick export'})
		}

		const rows = parseCsv(lines.slice(headerIndex).join('\n'))
		const header = rows[0].map(h => h.trim().toLowerCase())
		const at = name => header.indexOf(name)

		const grouped = new Map()
		for (const row of rows.slice(1)) {
			if (row.every(c => !String(c ?? '').trim())) {
				continue
			}
			const get = name => {
				const i = at(name)
				return i === -1 ? '' : String(row[i] ?? '').trim()
			}

			const listName = get('list name') || 'TickTick'
			if (!grouped.has(listName)) {
				grouped.set(listName, [])
			}

			const tags = get('tags')
			grouped.get(listName).push({
				title: get('title') || 'Untitled',
				description: get('content'),
				// TickTick: 0 normal, 1 completed, 2 archived.
				done: ['1', '2'].includes(get('status')),
				priority: Number(get('priority')) || 0,
				due_date: usableDate(get('due date')),
				start_date: usableDate(get('start date')),
				labels: tags ? tags.split(/[,;]/).map(t => t.trim()).filter(Boolean) : [],
				reminders: [usableDate(get('reminder'))].filter(Boolean),
			})
		}

		if (grouped.size === 0) {
			return res.status(400).json({message: 'no tasks were found in that file'})
		}

		const result = await importProjects(
			req.user.id,
			[...grouped].map(([title, tasks]) => ({title, tasks})),
			'ticktick',
		)
		return res.json({message: `imported ${result.tasks} task(s) into ${result.projects} project(s)`})
	} catch (err) {
		return next(err)
	}
})

// --- WeKan board export ------------------------------------------------

migrationRouter.post('/migration/wekan/migrate', upload.any(), async (req, res, next) => {
	try {
		const buffer = readUpload(req)
		if (!buffer) {
			return res.status(400).json({message: 'no file was uploaded'})
		}

		const boards = [].concat(JSON.parse(buffer.toString('utf8')))
		const projects = boards.map(board => {
			const listNames = new Map((board.lists ?? []).map(l => [l._id, l.title]))
			const commentsByCard = new Map()
			for (const c of board.comments ?? []) {
				if (!commentsByCard.has(c.cardId)) {
					commentsByCard.set(c.cardId, [])
				}
				commentsByCard.get(c.cardId).push(c.text)
			}

			return {
				title: board.title || 'WeKan board',
				description: board.description ?? '',
				tasks: (board.cards ?? [])
					.filter(card => !card.archived)
					.map(card => ({
						title: card.title,
						description: card.description,
						done: Boolean(card.isFinished),
						due_date: usableDate(card.dueAt),
						start_date: usableDate(card.startAt),
						end_date: usableDate(card.endAt),
						labels: [listNames.get(card.listId)].filter(Boolean),
						comments: commentsByCard.get(card._id) ?? [],
					})),
			}
		})

		if (projects.length === 0) {
			return res.status(400).json({message: 'no boards were found in that file'})
		}

		const result = await importProjects(req.user.id, projects, 'wekan')
		return res.json({message: `imported ${result.tasks} card(s) from ${result.projects} board(s)`})
	} catch (err) {
		if (err instanceof SyntaxError) {
			return res.status(400).json({message: 'that file is not a valid WeKan board export'})
		}
		return next(err)
	}
})
