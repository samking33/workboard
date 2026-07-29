/**
 * RFC 4180 CSV reader.
 *
 * Hand-written rather than a dependency because the awkward parts are the ones
 * a naive split(',') gets wrong — quoted fields containing the delimiter, escaped
 * quotes ("" inside a quoted field), and newlines inside quotes — and those are
 * about thirty lines to do properly.
 */
export function parseCsv(text, {delimiter = ',', quoteChar = '"'} = {}) {
	// A BOM would otherwise become part of the first column's name.
	const input = text.replace(/^﻿/, '')
	const rows = []
	let row = []
	let field = ''
	let inQuotes = false
	let i = 0

	while (i < input.length) {
		const c = input[i]

		if (inQuotes) {
			if (c === quoteChar) {
				if (input[i + 1] === quoteChar) {
					field += quoteChar
					i += 2
					continue
				}
				inQuotes = false
				i++
				continue
			}
			field += c
			i++
			continue
		}

		if (c === quoteChar) {
			inQuotes = true
			i++
			continue
		}

		if (c === delimiter) {
			row.push(field)
			field = ''
			i++
			continue
		}

		if (c === '\r' && input[i + 1] === '\n') {
			row.push(field)
			rows.push(row)
			row = []
			field = ''
			i += 2
			continue
		}

		if (c === '\n' || c === '\r') {
			row.push(field)
			rows.push(row)
			row = []
			field = ''
			i++
			continue
		}

		field += c
		i++
	}

	// Whatever is left when the input ends is the last field, unless the file
	// ended with a newline and there is nothing pending.
	if (field !== '' || row.length > 0) {
		row.push(field)
		rows.push(row)
	}

	return rows
}

/** Picks the delimiter that yields the most consistent column count. */
export function detectDelimiter(text) {
	const sample = text.split(/\r?\n/).slice(0, 20).join('\n')
	let best = {delimiter: ',', score: -1}

	for (const delimiter of [',', ';', '\t', '|']) {
		const rows = parseCsv(sample, {delimiter}).filter(r => r.length > 0)
		if (rows.length === 0) {
			continue
		}
		const width = rows[0].length
		if (width < 2) {
			continue
		}
		// Consistent width across rows is the signal; a wrong delimiter gives
		// ragged rows or a single column.
		const consistent = rows.filter(r => r.length === width).length / rows.length
		const score = consistent * width
		if (score > best.score) {
			best = {delimiter, score}
		}
	}

	return best.delimiter
}

// Go layout strings, as the client sends them, mapped to how the field is laid
// out so a date can be read without a date library.
const DATE_LAYOUTS = {
	'2006-01-02': /^(\d{4})-(\d{2})-(\d{2})$/,
	'2006-01-02T15:04:05': /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
	'2006-01-02 15:04:05': /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
	'2006/01/02': /^(\d{4})\/(\d{2})\/(\d{2})$/,
	'02/01/2006': /^(\d{2})\/(\d{2})\/(\d{4})$/,
	'01/02/2006': /^(\d{2})\/(\d{2})\/(\d{4})$/,
	'02-01-2006': /^(\d{2})-(\d{2})-(\d{4})$/,
	'01-02-2006': /^(\d{2})-(\d{2})-(\d{4})$/,
	'02.01.2006': /^(\d{2})\.(\d{2})\.(\d{4})$/,
}

const DAY_FIRST = new Set(['02/01/2006', '02-01-2006', '02.01.2006'])

/**
 * @returns {Date|null} null when the value does not match, so a bad cell is
 *          skipped rather than becoming 1970 or today
 */
export function parseDate(value, layout = '2006-01-02') {
	const text = String(value ?? '').trim()
	if (!text) {
		return null
	}

	const pattern = DATE_LAYOUTS[layout]
	const m = pattern ? pattern.exec(text) : null
	if (!m) {
		// Fall back to ISO, which covers most exports regardless of the layout
		// the user picked.
		const iso = new Date(text)
		return Number.isNaN(iso.getTime()) ? null : iso
	}

	let year, month, day
	if (m[1].length === 4) {
		[, year, month, day] = m
	} else if (DAY_FIRST.has(layout)) {
		[, day, month, year] = m
	} else {
		[, month, day, year] = m
	}

	const date = new Date(Date.UTC(
		Number(year), Number(month) - 1, Number(day),
		Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
	))
	return Number.isNaN(date.getTime()) ? null : date
}

// Header names that map to a task attribute without the user choosing.
const GUESSES = {
	title: ['title', 'task', 'name', 'summary', 'subject'],
	description: ['description', 'notes', 'note', 'details', 'content', 'body'],
	due_date: ['due date', 'due_date', 'due', 'duedate', 'deadline'],
	start_date: ['start date', 'start_date', 'start', 'startdate'],
	end_date: ['end date', 'end_date', 'end', 'enddate'],
	done: ['done', 'completed', 'complete', 'status', 'is done'],
	priority: ['priority', 'importance'],
	labels: ['labels', 'label', 'tags', 'tag', 'categories'],
	project: ['project', 'list', 'board', 'folder'],
	reminder: ['reminder', 'remind', 'reminders'],
}

export function suggestMapping(columns) {
	const used = new Set()

	return columns.map((column, index) => {
		const name = String(column ?? '').trim().toLowerCase()
		let attribute = 'ignore'

		for (const [attr, names] of Object.entries(GUESSES)) {
			if (!used.has(attr) && names.includes(name)) {
				attribute = attr
				used.add(attr)
				break
			}
		}

		return {column_index: index, column_name: column, attribute}
	})
}
