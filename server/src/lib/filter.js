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
	project: {sql: 't.project_id', type: 'number'},
	projectid: {sql: 't.project_id', type: 'number'},
	// Relations resolve to EXISTS subqueries, built below.
	assignees: {type: 'relation', relation: 'assignees'},
	labels: {type: 'relation', relation: 'labels'},
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

const CONDITION = /^\s*([a-zA-Z_]+)\s*(>=|<=|!=|==|=|>|<|\bnot in\b|\bin\b|\blike\b)\s*(.+?)\s*$/i

function parseCondition(text) {
	const m = CONDITION.exec(text)
	if (!m) {
		return null
	}

	const [, rawField, rawOp, rawValue] = m
	const field = FIELDS[rawField.toLowerCase()]
	if (!field) {
		// Unknown field: refuse rather than ignore, so a bad filter is visible
		// instead of silently returning everything.
		throw new Error(`unknown filter field: ${rawField}`)
	}

	const operator = OPERATORS[rawOp.toLowerCase()]
	if (!operator) {
		throw new Error(`unknown filter operator: ${rawOp}`)
	}

	if (field.type === 'relation') {
		return relationClause(field.relation, operator, rawValue)
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
 * @returns {{sql: string, params: unknown[]}|null} null when there is nothing to filter
 * @throws on an unparseable filter, so the caller can answer 400 rather than
 *         quietly returning the unfiltered list
 */
export function buildFilter(expression) {
	const text = String(expression ?? '').trim()
	if (!text) {
		return null
	}

	// Split on || first, then && — no parentheses, matching the client's syntax.
	const orParts = text.split('||')
	const orSql = []
	const params = []

	for (const orPart of orParts) {
		const andSql = []
		for (const andPart of orPart.split('&&')) {
			if (!andPart.trim()) {
				continue
			}
			const clause = parseCondition(andPart)
			if (!clause) {
				throw new Error(`could not parse filter: ${andPart.trim()}`)
			}
			andSql.push(clause.sql)
			params.push(...clause.params)
		}
		if (andSql.length > 0) {
			orSql.push(`(${andSql.join(' AND ')})`)
		}
	}

	if (orSql.length === 0) {
		return null
	}
	return {sql: `(${orSql.join(' OR ')})`, params}
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
