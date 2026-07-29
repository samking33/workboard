/**
 * iCalendar (RFC 5545) VTODO serialisation and parsing.
 *
 * Only the subset CalDAV clients actually use for tasks. Written by hand rather
 * than pulled in: the fiddly parts are line folding and escaping, which are a
 * few lines each, and the parse side only has to survive what clients send.
 */

const PRODID = '-//FSOC Workboard//NONSGML v1.0//EN'

/** Text values must escape these, or a description with a comma breaks the file. */
function escapeText(value) {
	return String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r?\n/g, '\\n')
}

function unescapeText(value) {
	return String(value ?? '')
		.replace(/\\n/gi, '\n')
		.replace(/\\,/g, ',')
		.replace(/\\;/g, ';')
		.replace(/\\\\/g, '\\')
}

/** RFC 5545 caps lines at 75 octets; longer ones continue with a leading space. */
function fold(line) {
	if (Buffer.byteLength(line, 'utf8') <= 75) {
		return line
	}

	const out = []
	let current = ''
	for (const char of line) {
		// Measured in bytes, not characters, so a multi-byte character never
		// straddles a fold boundary.
		if (Buffer.byteLength(current + char, 'utf8') > (out.length === 0 ? 75 : 74)) {
			out.push(current)
			current = char
		} else {
			current += char
		}
	}
	out.push(current)
	return out.join('\r\n ')
}

function icalDate(value, {dateOnly = false} = {}) {
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) {
		return null
	}
	const iso = date.toISOString().replace(/[-:]/g, '')
	return dateOnly ? iso.slice(0, 8) : `${iso.slice(0, 15)}Z`
}

// Vikunja priority is 0-5 low-to-high; iCalendar is 1-9 high-to-low.
function toIcalPriority(priority) {
	const p = Number(priority) || 0
	if (p <= 0) {
		return 0
	}
	return Math.max(1, Math.min(9, 10 - Math.round((p / 5) * 9)))
}

function fromIcalPriority(priority) {
	const p = Number(priority) || 0
	if (p <= 0) {
		return 0
	}
	return Math.max(1, Math.min(5, Math.round(((10 - p) / 9) * 5)))
}

export function taskToVTodo(task, {projectTitle} = {}) {
	const lines = [
		'BEGIN:VTODO',
		`UID:${task.uid || `fsoc-task-${task.id}`}`,
		`DTSTAMP:${icalDate(task.updated ?? new Date())}`,
		`SUMMARY:${escapeText(task.title)}`,
	]

	if (task.description) {
		// Descriptions are rich text in the app; CalDAV wants plain.
		lines.push(`DESCRIPTION:${escapeText(String(task.description).replace(/<[^>]*>/g, ''))}`)
	}
	if (task.due_date) {
		lines.push(`DUE:${icalDate(task.due_date)}`)
	}
	if (task.start_date) {
		lines.push(`DTSTART:${icalDate(task.start_date)}`)
	}
	if (task.created) {
		lines.push(`CREATED:${icalDate(task.created)}`)
	}
	if (task.done) {
		lines.push('STATUS:COMPLETED')
		lines.push('PERCENT-COMPLETE:100')
		if (task.done_at) {
			lines.push(`COMPLETED:${icalDate(task.done_at)}`)
		}
	} else {
		lines.push('STATUS:NEEDS-ACTION')
		if (task.percent_done) {
			lines.push(`PERCENT-COMPLETE:${Math.round(Number(task.percent_done) * 100)}`)
		}
	}

	const priority = toIcalPriority(task.priority)
	if (priority > 0) {
		lines.push(`PRIORITY:${priority}`)
	}
	for (const label of task.labels ?? []) {
		lines.push(`CATEGORIES:${escapeText(label.title ?? label)}`)
	}
	if (projectTitle) {
		lines.push(`X-FSOC-PROJECT:${escapeText(projectTitle)}`)
	}

	lines.push('END:VTODO')
	return lines.map(fold).join('\r\n')
}

export function buildCalendar(tasks, {projectTitle} = {}) {
	const body = tasks.map(t => taskToVTodo(t, {projectTitle})).join('\r\n')
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		`PRODID:${PRODID}`,
		projectTitle ? fold(`X-WR-CALNAME:${escapeText(projectTitle)}`) : null,
		body,
		'END:VCALENDAR',
		'',
	].filter(l => l !== null && l !== '').join('\r\n') + '\r\n'
}

function parseIcalDate(value, params = '') {
	if (!value) {
		return null
	}
	const text = value.trim()

	// VALUE=DATE means a whole day, written as YYYYMMDD.
	const dateOnly = /VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(text)
	if (dateOnly) {
		const m = /^(\d{4})(\d{2})(\d{2})/.exec(text)
		return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
	}

	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(text)
	if (!m) {
		const fallback = new Date(text)
		return Number.isNaN(fallback.getTime()) ? null : fallback
	}

	// A time with no Z and no TZID is floating; treating it as UTC is the only
	// consistent choice without knowing the client's zone.
	return new Date(Date.UTC(
		Number(m[1]), Number(m[2]) - 1, Number(m[3]),
		Number(m[4]), Number(m[5]), Number(m[6]),
	))
}

/** @returns {object|null} task fields, or null when the input holds no VTODO */
export function parseVTodo(text) {
	// Unfold first: a folded line continues with a space or tab.
	const unfolded = String(text ?? '').replace(/\r?\n[ \t]/g, '')
	const lines = unfolded.split(/\r?\n/)

	let inTodo = false
	const task = {labels: []}

	for (const line of lines) {
		if (/^BEGIN:VTODO/i.test(line)) {
			inTodo = true
			continue
		}
		if (/^END:VTODO/i.test(line)) {
			break
		}
		if (!inTodo) {
			continue
		}

		const split = line.indexOf(':')
		if (split === -1) {
			continue
		}
		const rawName = line.slice(0, split)
		const value = line.slice(split + 1)
		const [name, ...paramParts] = rawName.split(';')
		const params = paramParts.join(';')
		const key = name.trim().toUpperCase()

		switch (key) {
			case 'UID':
				task.uid = value.trim()
				break
			case 'SUMMARY':
				task.title = unescapeText(value)
				break
			case 'DESCRIPTION':
				task.description = unescapeText(value)
				break
			case 'DUE':
				task.due_date = parseIcalDate(value, params)
				break
			case 'DTSTART':
				task.start_date = parseIcalDate(value, params)
				break
			case 'COMPLETED':
				task.done_at = parseIcalDate(value, params)
				task.done = true
				break
			case 'STATUS':
				task.done = /COMPLETED/i.test(value)
				break
			case 'PERCENT-COMPLETE':
				task.percent_done = Math.max(0, Math.min(1, (Number(value) || 0) / 100))
				break
			case 'PRIORITY':
				task.priority = fromIcalPriority(value)
				break
			case 'CATEGORIES':
				// One line can carry several, comma-separated and individually escaped.
				task.labels.push(...value.split(/(?<!\\),/).map(v => unescapeText(v).trim()).filter(Boolean))
				break
			default:
				break
		}
	}

	if (!inTodo && !task.title) {
		return null
	}
	if (task.done && task.percent_done === undefined) {
		task.percent_done = 1
	}
	return task
}
