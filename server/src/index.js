import path from 'node:path'
import {fileURLToPath} from 'node:url'

import cors from 'cors'
import express from 'express'

import {config} from './lib/config.js'
import {ping} from './lib/db.js'
import {authRouter} from './routes/auth.js'
import {projectsRouter} from './routes/projects.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.disable('x-powered-by')
app.use(express.json({limit: '1mb'}))
app.use(cors({origin: true, credentials: true}))

// --- API ---------------------------------------------------------------
const api = express.Router()

// Public endpoints are registered before any router that applies auth
// middleware at the router level: `router.use(requireAuth)` runs for every
// request that reaches that router, not only ones matching its routes, so a
// public route mounted after it would answer 401.
api.get('/info', (_req, res) => {
	res.json({
		version: 'fsoc-node-dev',
		frontend_url: config.publicUrl,
		motd: '',
		link_sharing_enabled: false,
		max_file_size: String(config.maxFileSizeBytes),
		auth: {
			local: {enabled: true, registration_enabled: config.registrationEnabled},
			ldap: {enabled: false},
			openid_connect: {enabled: false, providers: null},
		},
	})
})

// authRouter guards its own routes individually, so it is safe anywhere.
api.use(authRouter)
// projectsRouter applies requireAuth for the whole router — keep it last.
api.use(projectsRouter)

app.use('/api/v1', api)

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
	console.log(`[fsoc] listening on http://localhost:${config.port}`)
	console.log(`[fsoc] serving frontend from ${frontendDir}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => server.close(() => process.exit(0)))
}
