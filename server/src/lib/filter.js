/**
 * Parses the client's filter expressions into parameterised SQL.
 *
 * Syntax, matching what the Vue client sends:
 *   done = false
 *   priority >= 3 && dueDate < now
 *   title like 'design' || labels in 1,2
 *
 * Nothing from the input ever reaches the SQL string: field names are resolved
 * through an allowlist, operators through a fixed map, and every value becomes a
 * bound parameter. An unknown field is an error rather than something passed
 * through, so a typo cannot become an injection.
 */

// client field -> column expression. Only these can be filtered on.
//
// Keyed without underscores and looked up the same way, because the client uses
// both spellings — `due_date` in saved filters and `dueDate` in the query UI.
const FIELDS = {
	done: {sql: 't.done', type: 'bool'},
	priority: {sql: 't.priority', type: 'number'},
	percentdone: {sql: 't.percent_done', type: 'number'},
	duedate: {sql: 't.due_date', type: 'date'},
	startdate: {sql: 't.start_date', type: 'date'},
	enddate: {sql: 't.end_date', type: 'date'},
	doneat: {sql: 't.done_at', type: 'date'},
	created: {sql: 't.created', type: 'date'},
	updated: {sql: 't.updated', type: 'date'},
	title: {sql: 't.title', type: 'string'},
	description: {sql: 't.description', type: 'string'},
	identifier: {sql: 't.`index`', type: 'number'},
	index: {sql: 't.`index`', type: 'number'},
	project: {sql: 't.project_id', type: 'number'},
	projectid: {sql: 't.project_id', type: 'number'},
	reminders: {sql: 't.id', type: 'reminder'},
	// Relations resolve to EXISTS subqueries, built below.
	assignees: {type: 'relation', relation: 'assignees'},
	labels: {type: 'relation', relation: 'labels'},
}

function lookupField(name) {
	return FIELDS[String(name).toLowerCase().replace(/_/g, '')]
}

const OPERATORS = {
	'=': '=',
	'==': '=',
	'!=': '<>',
	'>': '>',
	'>=': '>=',
	'<': '<',
	'<=': '<=',
	like: 'LIKE',
	in: 'IN',
	'not in': 'NOT IN',
}

// Relative dates the client uses instead of literals.
function resolveDate(raw) {
	const value = String(raw).trim().replace(/^['"]|['"]$/g, '')
	const now = new Date()

	if (value === 'now') {
		return now
	}

	// now/d, now+30d, now-1w — offset from today.
	const m = /^now([+-])(\d+)([dwmy])$/i.exec(value)
	if (m) {
		const [, sign, amount, unit] = m
		const n = Number(amount) * (sign === '-' ? -1 : 1)
		const d = new Date(now)
		if (unit === 'd') {
			d.setDate(d.getDate() + n)
		} else if (unit === 'w') {
			d.setDate(d.getDate() + n * 7)
		} else if (unit === 'm') {
			d.setMonth(d.getMonth() + n)
		} else {
			d.setFullYear(d.getFullYear() + n)
		}
		return d
	}

	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime()) ? null : parsed
}

function coerce(type, raw) {
	const value = String(raw).trim().replace(/^['"]|['"]$/g, '')
	if (type === 'bool') {
		return value.toLowerCase() === 'true' ? 1 : 0
	}
	if (type === 'number') {
		const n = Number(value)
		return Number.isFinite(n) ? n : 0
	}
	if (type === 'date') {
		return resolveDate(value)
	}
	return value
}

/** Builds the EXISTS clause for assignees/labels. */
function relationClause(relation, operator, raw) {
	const values = String(raw).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
	if (values.length === 0) {
		return null
	}
	const ph = values.map(() => '?').join(',')
	const negate = operator === 'NOT IN' || operator === '<>'

	if (relation === 'assignees') {
		// Accepts usernames or ids; the client sends usernames.
		return {
			sql: `${negate ? 'NOT ' : ''}EXISTS (
				SELECT 1 FROM task_assignees ta JOIN users u ON u.id = ta.user_id
				WHERE ta.task_id = t.id AND (u.username IN (${ph}) OR u.id IN (${ph})))`,
			params: [...values, ...values],
		}
	}

	return {
		sql: `${negate ? 'NOT ' : ''}EXISTS (
			SELECT 1 FROM label_tasks lt JOIN labels l ON l.id = lt.label_id
			WHERE lt.task_id = t.id AND (l.title IN (${ph}) OR l.id IN (${ph})))`,
		params: [...values, ...values],
	}
}

/**
 * Splits the expression into tokens.
 *
 * Quoted values are one token even when they contain spaces, && or a closing
 * paren — the client writes dates as '2026-08-05T18:55:07.347Z' and titles as
 * "quarterly (Q3) review", and splitting those on punctuation corrupts them.
 */
function tokenize(input) {
	const tokens = []
	let i = 0

	while (i < input.length) {
		const c = input[i]

		if (/\s/.test(c)) {
			i++
			continue
		}

		if (c === '(' || c === ')') {
			tokens.push({type: c})
			i++
			continue
		}

		if (input.startsWith('&&', i)) {
			tokens.push({type: 'and'})
			i += 2
			continue
		}
		if (input.startsWith('||', i)) {
			tokens.push({type: 'or'})
			i += 2
			continue
		}

		if (c === '"' || c === '\'') {
			let value = ''
			i++
			while (i < input.length && input[i] !== c) {
				// A backslash escapes the quote character inside a value.
				if (input[i] === '\\' && input[i + 1] === c) {
					value += c
					i += 2
					continue
				}
				value += input[i]
				i++
			}
			i++
			tokens.push({type: 'value', value, quoted: true})
			continue
		}

		const operator = ['>=', '<=', '!=', '==', '>', '<', '='].find(op => input.startsWith(op, i))
		if (operator) {
			tokens.push({type: 'op', value: operator})
			i += operator.length
			continue
		}

		let word = ''
		while (i < input.length && !/[\s()=<>!&|]/.test(input[i])) {
			word += input[i]
			i++
		}
		if (!word) {
			// Nothing consumed: a stray character we do not understand.
			throw new Error(`unexpected character in filter: ${c}`)
		}

		const lower = word.toLowerCase()
		if (lower === 'in' || lower === 'like' || lower === 'not') {
			tokens.push({type: 'op', value: lower})
		} else {
			tokens.push({type: 'value', value: word})
		}
	}

	return tokens
}

function conditionFrom(fieldName, operatorText, rawValue) {
	const field = lookupField(fieldName)
	if (!field) {
		// Unknown field: refuse rather than ignore, so a bad filter is visible
		// instead of silently returning everything.
		throw new Error(`unknown filter field: ${fieldName}`)
	}

	const operator = OPERATORS[operatorText.toLowerCase()]
	if (!operator) {
		throw new Error(`unknown filter operator: ${operatorText}`)
	}

	if (field.type === 'relation') {
		return relationClause(field.relation, operator, rawValue)
	}

	if (field.type === 'reminder') {
		// The client filters on "has a reminder before X", which lives in another
		// table, so it becomes an EXISTS rather than a column comparison.
		const value = coerce('date', rawValue)
		if (value === null) {
			throw new Error(`invalid date in filter: ${rawValue}`)
		}
		return {
			sql: `EXISTS (SELECT 1 FROM task_reminders tr WHERE tr.task_id = t.id AND tr.reminder ${operator} ?)`,
			params: [value],
		}
	}

	if (operator === 'IN' || operator === 'NOT IN') {
		const values = String(rawValue).split(',').map(v => coerce(field.type, v))
		const ph = values.map(() => '?').join(',')
		return {sql: `${field.sql} ${operator} (${ph})`, params: values}
	}

	const value = coerce(field.type, rawValue)
	if (field.type === 'date' && value === null) {
		throw new Error(`invalid date in filter: ${rawValue}`)
	}
	if (operator === 'LIKE') {
		return {sql: `${field.sql} LIKE ?`, params: [`%${value}%`]}
	}

	return {sql: `${field.sql} ${operator} ?`, params: [value]}
}

/**
 * Recursive descent over `or -> and -> primary`, so precedence and nesting both
 * come out right. The client's Gantt view sends parenthesised groups joined by
 * ||, which a plain split on the operators cannot represent.
 */
function parseExpression(tokens) {
	let pos = 0

	const peek = () => tokens[pos]
	const take = () => tokens[pos++]

	function primary() {
		const token = peek()
		if (!token) {
			throw new Error('filter ended unexpectedly')
		}

		if (token.type === '(') {
			take()
			const inner = parseOr()
			if (peek()?.type !== ')') {
				throw new Error('unbalanced parentheses in filter')
			}
			take()
			return inner
		}

		if (token.type !== 'value') {
			throw new Error(`expected a field name in filter, found ${token.value ?? token.type}`)
		}
		const field = take().value

		let operator = take()
		if (!operator || operator.type !== 'op') {
			throw new Error(`expected an operator after ${field}`)
		}
		let operatorText = operator.value
		// "not in" arrives as two tokens.
		if (operatorText === 'not' && peek()?.value === 'in') {
			take()
			operatorText = 'not in'
		}

		const valueToken = take()
		if (!valueToken || valueToken.type !== 'value') {
			throw new Error(`expected a value after ${field} ${operatorText}`)
		}

		// An unquoted list keeps going across commas: labels in a, b, c.
		let value = valueToken.value
		while (!valueToken.quoted && peek()?.type === 'value' && value.endsWith(',')) {
			value += take().value
		}

		return conditionFrom(field, operatorText, value)
	}

	function parseAnd() {
		let left = primary()
		while (peek()?.type === 'and') {
			take()
			const right = primary()
			left = {sql: `(${left.sql} AND ${right.sql})`, params: [...left.params, ...right.params]}
		}
		return left
	}

	function parseOr() {
		let left = parseAnd()
		while (peek()?.type === 'or') {
			take()
			const right = parseAnd()
			left = {sql: `(${left.sql} OR ${right.sql})`, params: [...left.params, ...right.params]}
		}
		return left
	}

	const result = parseOr()
	if (pos < tokens.length) {
		throw new Error('trailing input after the filter expression')
	}
	return result
}

/**
 * @returns {{sql: string, params: unknown[]}|null} null when there is nothing to filter
 * @throws on an unparseable filter, so the caller can answer 400 rather than
 *         quietly returning the unfiltered list
 */
export function buildFilter(expression) {
	const text = String(expression ?? '').trim()
	if (!text) {
		return null
	}

	const tokens = tokenize(text)
	if (tokens.length === 0) {
		return null
	}

	return parseExpression(tokens)
}

// Sorting is also caller-supplied, so it gets the same allowlist treatment —
// an ORDER BY cannot be parameterised.
const SORTABLE = {
	id: 't.id',
	title: 't.title',
	done: 't.done',
	priority: 't.priority',
	percentdone: 't.percent_done',
	duedate: 't.due_date',
	startdate: 't.start_date',
	enddate: 't.end_date',
	created: 't.created',
	updated: 't.updated',
	position: 'tp.position',
	index: 't.`index`',
}

export function buildOrderBy(sortBy, orderBy) {
	const fields = [].concat(sortBy ?? []).filter(Boolean)
	const directions = [].concat(orderBy ?? [])
	const parts = []

	fields.forEach((field, i) => {
		const column = SORTABLE[String(field).toLowerCase()]
		if (!column) {
			return
		}
		const dir = String(directions[i] ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
		parts.push(`${column} ${dir}`)
	})

	return parts.length > 0 ? parts.join(', ') : null
}
