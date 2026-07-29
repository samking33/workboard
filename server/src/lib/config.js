import 'dotenv/config'

/**
 * Configuration is read from the same VIKUNJA_* environment variables the Go
 * server used, so an existing deployment's env file works unchanged.
 */
const env = process.env

function required(name, fallback) {
	const v = env[name] ?? fallback
	if (v === undefined || v === '') {
		throw new Error(`${name} is required`)
	}
	return v
}

// "host:port" — the Go config used a single string, keep that shape.
const [dbHost, dbPort = '3306'] = required('VIKUNJA_DATABASE_HOST', '127.0.0.1:3306').split(':')

export const config = {
	port: Number(env.PORT ?? 3456),

	publicUrl: required('VIKUNJA_SERVICE_PUBLICURL', 'http://localhost:3456/'),

	// Signs session tokens. A random value per boot would log everyone out on
	// every restart, so this must be set in any real deployment.
	secret: required('VIKUNJA_SERVICE_SECRET'),

	// Matches the Go server's default of 3 days.
	tokenTtlSeconds: Number(env.VIKUNJA_SERVICE_JWTTTL ?? 259200),

	registrationEnabled: (env.VIKUNJA_SERVICE_ENABLEREGISTRATION ?? 'false') === 'true',

	db: {
		host: dbHost,
		port: Number(dbPort),
		user: required('VIKUNJA_DATABASE_USER'),
		password: env.VIKUNJA_DATABASE_PASSWORD ?? '',
		database: required('VIKUNJA_DATABASE_DATABASE'),
	},

	filesPath: env.VIKUNJA_FILES_BASEPATH ?? './files',
	maxFileSizeBytes: Number(env.VIKUNJA_FILES_MAXSIZE_BYTES ?? 100 * 1024 * 1024),

	webhookTimeoutMs: Number(env.VIKUNJA_WEBHOOKS_TIMEOUTSECONDS ?? 30) * 1000,

	// Mirrors the Go server's outgoingrequests.allownonroutableips. Off by
	// default: with it on, a user-supplied webhook URL can reach anything the
	// server can, including internal services and cloud metadata endpoints. Only
	// turn it on when the webhook receivers are on the same trusted network.
	allowNonRoutableWebhookTargets:
		(env.VIKUNJA_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS ?? 'false') === 'true',

	// Off by default: an unreachable relay would make every notification attempt
	// hang, so mail only runs once a host is deliberately configured.
	mail: {
		enabled: (env.VIKUNJA_MAILER_ENABLED ?? 'false') === 'true',
		host: env.VIKUNJA_MAILER_HOST ?? '',
		port: Number(env.VIKUNJA_MAILER_PORT ?? 587),
		username: env.VIKUNJA_MAILER_USERNAME ?? '',
		password: env.VIKUNJA_MAILER_PASSWORD ?? '',
		fromEmail: env.VIKUNJA_MAILER_FROMEMAIL ?? 'noreply@localhost',
		forceSSL: (env.VIKUNJA_MAILER_FORCESSL ?? 'false') === 'true',
		skipTLSVerify: (env.VIKUNJA_MAILER_SKIPTLSVERIFY ?? 'false') === 'true',
	},

	// Directory holding the built Vue frontend. The Go server embedded it; here
	// it is served from disk.
	frontendPath: env.FSOC_FRONTEND_PATH ?? '../frontend/dist',
}
