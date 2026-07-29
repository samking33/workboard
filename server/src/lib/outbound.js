import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {URL} from 'node:url'

import {config} from './config.js'

/**
 * Outbound HTTP for URLs a user supplied (webhook targets).
 *
 * These requests originate from the server, so without a guard a user can point
 * one at 127.0.0.1, a container-internal service, or a cloud metadata endpoint
 * at 169.254.169.254 and use us to reach things they cannot — server-side
 * request forgery. The Go server blocks this at dial time; we do the same by
 * checking each resolved address and then connecting to that exact address, so
 * a name that resolves differently on the second lookup cannot slip past the
 * check (DNS rebinding).
 */

function ipv4ToInt(ip) {
	return ip.split('.').reduce((acc, part) => (acc << 8 >>> 0) + Number(part), 0) >>> 0
}

// Everything not routable on the public internet.
const BLOCKED_V4 = [
	['0.0.0.0', 8], // this network
	['10.0.0.0', 8], // private
	['100.64.0.0', 10], // carrier-grade NAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local, incl. cloud metadata
	['172.16.0.0', 12], // private
	['192.0.0.0', 24], // IETF protocol assignments
	['192.0.2.0', 24], // TEST-NET-1
	['192.88.99.0', 24], // 6to4 relay anycast
	['192.168.0.0', 16], // private
	['198.18.0.0', 15], // benchmarking
	['198.51.100.0', 24], // TEST-NET-2
	['203.0.113.0', 24], // TEST-NET-3
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4], // reserved, incl. broadcast
].map(([base, bits]) => ({base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0}))

function isBlockedV4(ip) {
	const value = ipv4ToInt(ip)
	return BLOCKED_V4.some(({base, mask}) => (value & mask) >>> 0 === base)
}

function isBlockedV6(ip) {
	const address = ip.toLowerCase().split('%')[0]

	// An IPv4-mapped address (::ffff:127.0.0.1) reaches the same host as the
	// bare IPv4 one, so it has to go through the same rules.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
	if (mapped) {
		return isBlockedV4(mapped[1])
	}

	if (address === '::' || address === '::1') {
		return true
	}

	const head = address.split(':')[0]
	const first = parseInt(head || '0', 16)
	if (Number.isNaN(first)) {
		return true
	}

	// fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
	if ((first & 0xfe00) === 0xfc00) {
		return true
	}
	if ((first & 0xffc0) === 0xfe80) {
		return true
	}
	if ((first & 0xff00) === 0xff00) {
		return true
	}
	// 2001:db8::/32 documentation, 64:ff9b::/96 NAT64 to IPv4.
	if (address.startsWith('2001:db8:') || address.startsWith('64:ff9b:')) {
		return true
	}

	return false
}

export function isBlockedAddress(ip) {
	if (config.allowNonRoutableWebhookTargets) {
		return false
	}

	const family = net.isIP(ip)
	if (family === 4) {
		return isBlockedV4(ip)
	}
	if (family === 6) {
		return isBlockedV6(ip)
	}
	return true
}

/** Rejects the whole request if any candidate address is non-routable. */
async function resolveSafely(hostname) {
	if (net.isIP(hostname)) {
		if (isBlockedAddress(hostname)) {
			throw new Error(`refusing to call a non-routable address: ${hostname}`)
		}
		return hostname
	}

	const records = await dns.lookup(hostname, {all: true, verbatim: true})
	if (records.length === 0) {
		throw new Error(`could not resolve ${hostname}`)
	}

	// If any record is internal, refuse outright rather than picking a public
	// one — a host answering with both is exactly the rebinding shape.
	for (const r of records) {
		if (isBlockedAddress(r.address)) {
			throw new Error(`${hostname} resolves to a non-routable address (${r.address})`)
		}
	}

	return records[0].address
}

/**
 * POSTs JSON to a user-supplied URL.
 *
 * Redirects are deliberately not followed: a 302 to an internal host is the
 * standard way around a check like this one, and webhook receivers have no
 * reason to redirect.
 */
export async function postJson(targetUrl, body, {headers = {}, timeoutMs = config.webhookTimeoutMs} = {}) {
	const url = new URL(targetUrl)
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('only http and https targets are allowed')
	}

	const address = await resolveSafely(url.hostname)
	const payload = Buffer.from(JSON.stringify(body))
	const transport = url.protocol === 'https:' ? https : http

	return new Promise((resolve, reject) => {
		const req = transport.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? 443 : 80),
				path: url.pathname + url.search,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': payload.length,
					'User-Agent': 'FSOC-Webhook/1.0',
					...headers,
				},
				// Connect to the address we just vetted rather than resolving again.
				lookup: (_hostname, options, cb) => cb(null, address, net.isIP(address)),
				timeout: timeoutMs,
			},
			res => {
				const chunks = []
				res.on('data', c => chunks.push(c))
				res.on('end', () => resolve({
					status: res.statusCode,
					body: Buffer.concat(chunks).toString('utf8').slice(0, 2000),
				}))
			},
		)

		req.on('timeout', () => req.destroy(new Error(`webhook target did not respond within ${timeoutMs}ms`)))
		req.on('error', reject)
		req.end(payload)
	})
}
