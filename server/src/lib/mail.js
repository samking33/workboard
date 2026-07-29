import nodemailer from 'nodemailer'

import {config} from './config.js'

let transport = null

/**
 * Mail is optional. When it is off every send is a no-op that returns false, so
 * callers do not need to care — a task still gets its in-app notification even
 * on an instance with no relay configured.
 */
function getTransport() {
	if (!config.mail.enabled || !config.mail.host) {
		return null
	}
	if (transport) {
		return transport
	}

	transport = nodemailer.createTransport({
		host: config.mail.host,
		port: config.mail.port,
		// 465 is implicit TLS; everything else negotiates STARTTLS.
		secure: config.mail.forceSSL || config.mail.port === 465,
		auth: config.mail.username
			? {user: config.mail.username, pass: config.mail.password}
			: undefined,
		tls: {
			// Only ever set deliberately, for an internal relay with a self-signed
			// certificate — it disables the check that the relay is who it claims.
			rejectUnauthorized: !config.mail.skipTLSVerify,
		},
	})

	return transport
}

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'}

/** Task titles and comments reach the HTML body, so they are escaped, not trusted. */
function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c])
}

function layout(heading, lines, action) {
	const body = lines.map(l => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('')
	const button = action
		? `<p style="margin:24px 0 0">
			<a href="${escapeHtml(action.url)}" style="background:#1973ff;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a>
		</p>`
		: ''

	return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
		<h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(heading)}</h2>
		${body}${button}
		<hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 12px">
		<p style="margin:0;font-size:12px;color:#6b7280">Sent by FSOC Workboard</p>
	</div>`
}

/** @returns {Promise<boolean>} whether it was actually sent */
export async function sendMail({to, subject, heading, lines = [], action = null}) {
	const t = getTransport()
	if (!t || !to) {
		return false
	}

	try {
		await t.sendMail({
			from: config.mail.fromEmail,
			to,
			subject,
			text: [heading, '', ...lines, action ? `\n${action.label}: ${action.url}` : ''].join('\n'),
			html: layout(heading, lines, action),
		})
		return true
	} catch (err) {
		// A failing relay must not break the action that triggered the mail.
		console.error(`[fsoc] sending mail to ${to} failed: ${err.message}`)
		return false
	}
}

export async function verifyMailConnection() {
	const t = getTransport()
	if (!t) {
		return {enabled: false}
	}
	try {
		await t.verify()
		return {enabled: true, ok: true}
	} catch (err) {
		return {enabled: true, ok: false, error: err.message}
	}
}
