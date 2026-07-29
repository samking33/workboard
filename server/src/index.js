import path from 'node:path'
import {fileURLToPath} from 'node:url'

import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'

import {config} from './lib/config.js'
import {startCron} from './lib/cron.js'
import {ping} from './lib/db.js'
import {attachRealtime} from './lib/realtime.js'
import {accountRouter, publicAccountRouter} from './routes/account.js'
import {adminRouter} from './routes/admin.js'
import {authRouter} from './routes/auth.js'
import {caldavRouter, caldavTokenRouter} from './routes/caldav.js'
import {extrasRouter} from './routes/extras.js'
import {extras2Router} from './routes/extras2.js'
import {linkShareAuthRouter} from './routes/linkShareAuth.js'
import {FILE_MIGRATORS, migrationRouter} from './routes/migration.js'
import {miscRouter} from './routes/misc.js'
import {projectsRouter} from './routes/projects.js'
import {sharingRouter} from './routes/sharing.js'
import {storageRouter} from './routes/storage.js'
import {taskDetailRouter} from './routes/taskDetail.js'
import {tasksRouter} from './routes/tasks.js'
import {teamsRouter} from './routes/teams.js'
import {webhooksRouter} from './routes/webhooks.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.disable('x-powered-by')
app.use(cookieParser())
app.use(express.json({limit: '1mb'}))
app.use(cors({origin: true, credentials: true}))

// --- API ---------------------------------------------------------------
const api = express.Router()

/**
 * The client pages through list endpoints with `while (page <= totalPages)`,
 * reading these headers. Without them totalPages stays 0 and only the first
 * page is ever fetched, so anyone past the first 50 projects or tasks silently
 * loses the rest.
 */
api.use((req, res, next) => {
	res.paginate = (total, perPage) => {
		res.setHeader('x-pagination-result-count', String(total))
		res.setHeader('x-pagination-limit', String(perPage))
		res.setHeader('x-pagination-total-pages', String(Math.max(1, Math.ceil(total / perPage))))
	}
	next()
})

// Public endpoints are registered before any router that applies auth
// middleware at the router level: `router.use(requireAuth)` runs for every
// request that reaches that router, not only ones matching its routes, so a
// public route mounted after it would answer 401.
api.get('/info', (_req, res) => {
	res.json({
		version: 'fsoc-node-dev',
		frontend_url: config.publicUrl,
		motd: '',
		link_sharing_enabled: true,
		max_file_size: String(config.maxFileSizeBytes),
		// The client builds its import screen from this list, so a migrator absent
		// here is simply not offered.
		available_migrators: FILE_MIGRATORS,
		task_comments_enabled: true,
		enabled_background_providers: ['upload'],
		// The client hides the admin panel and time tracking unless the server
		// says it serves them. This build implements both, so it says so.
		enabled_pro_features: ['admin_panel', 'time_tracking'],
		auth: {
			local: {enabled: true, registration_enabled: config.registrationEnabled},
			ldap: {enabled: false},
			openid_connect: {enabled: false, providers: null},
		},
	})
})

// Public: holding the link is the credential, so this must sit ahead of every
// router that applies requireAuth.
// Public: a health check that needed a token could not detect a broken database.
api.get('/health', async (_req, res) => {
	try {
		await ping()
		return res.json({status: 'ok'})
	} catch (err) {
		return res.status(503).json({status: 'database unreachable', message: err.message})
	}
})

api.use(linkShareAuthRouter)
// Password reset and email confirmation: the caller has no session yet.
api.use(publicAccountRouter)

// authRouter guards its own routes individually, so it is safe anywhere.
api.use(authRouter)
// These apply requireAuth for the whole router — keep them after public routes.
api.use(projectsRouter)
api.use(tasksRouter)
api.use(taskDetailRouter)
api.use(storageRouter)
api.use(sharingRouter)
api.use(miscRouter)
api.use(extrasRouter)
api.use(webhooksRouter)
api.use(accountRouter)
api.use(migrationRouter)
api.use(caldavTokenRouter)
api.use(teamsRouter)
api.use(extras2Router)
api.use(adminRouter)

app.use('/api/v1', api)

// The storage client was written against /api/v2 (that is where the Go fork put
// it), so the same routes are mounted there too rather than changing the client.
const apiV2 = express.Router()
apiV2.use(storageRouter)
apiV2.use(adminRouter)
apiV2.use(extras2Router)
app.use('/api/v2', apiV2)

// CalDAV lives outside /api: it does its own Basic auth and speaks XML, and the
// JSON body parser above would reject its payloads.
app.use('/dav', caldavRouter)
// Clients probe this path before anything else to find the real endpoint.
app.all('/.well-known/caldav', (_req, res) => res.redirect(301, '/dav/'))

// --- frontend ----------------------------------------------------------
const frontendDir = path.resolve(here, '..', config.frontendPath)
app.use(express.static(frontendDir))

// The Vue client uses history routing, so any unmatched non-API path has no
// file behind it and must fall back to the app shell.
app.get(/^(?!\/api\/).*/, (_req, res) => {
	res.sendFile(path.join(frontendDir, 'index.html'))
})

// --- errors ------------------------------------------------------------
app.use((err, _req, res, _next) => {
	console.error('[fsoc]', err)
	res.status(500).json({message: 'internal server error'})
})

const server = app.listen(config.port, async () => {
	try {
		const version = await ping()
		console.log(`[fsoc] database ok (${version})`)
	} catch (err) {
		console.error('[fsoc] cannot reach the database:', err.message)
	}
	attachRealtime(server)
	startCron()
	console.log(`[fsoc] listening on http://localhost:${config.port}`)
	console.log(`[fsoc] serving frontend from ${frontendDir}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => server.close(() => process.exit(0)))
}
