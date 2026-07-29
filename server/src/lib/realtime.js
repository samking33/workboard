import jwt from 'jsonwebtoken'
import {WebSocketServer} from 'ws'

import {config} from './config.js'

/**
 * Pushes events to connected clients so notifications and time tracking update
 * without polling.
 *
 * The client's protocol: connect, send {action:'auth', token}, expect
 * {action:'auth.success'}, then {action:'subscribe', event} per event it wants.
 *
 * Authentication happens in a message rather than a header because the browser
 * WebSocket API cannot set one. Nothing is delivered before that message
 * arrives, and a socket that never authenticates is dropped.
 */

const AUTH_TIMEOUT_MS = 10_000

// userId -> Set<socket>. A user may have several tabs open.
const clients = new Map()

function add(userId, socket) {
	if (!clients.has(userId)) {
		clients.set(userId, new Set())
	}
	clients.get(userId).add(socket)
}

function remove(userId, socket) {
	const sockets = clients.get(userId)
	if (!sockets) {
		return
	}
	sockets.delete(socket)
	if (sockets.size === 0) {
		clients.delete(userId)
	}
}

/** Sends an event to one user's open tabs, if they asked for that event. */
export function pushToUser(userId, event, data) {
	for (const socket of clients.get(userId) ?? []) {
		if (socket.readyState === socket.OPEN && socket.subscriptions?.has(event)) {
			socket.send(JSON.stringify({event, data}))
		}
	}
}

export function attachRealtime(server) {
	const wss = new WebSocketServer({server, path: '/api/v1/ws'})

	wss.on('connection', socket => {
		socket.userId = null
		socket.subscriptions = new Set()

		// A socket that never authenticates is just an open file descriptor.
		const authTimer = setTimeout(() => {
			if (!socket.userId) {
				socket.send(JSON.stringify({error: 'auth_required'}))
				socket.close()
			}
		}, AUTH_TIMEOUT_MS)

		socket.on('message', raw => {
			let msg
			try {
				msg = JSON.parse(raw.toString())
			} catch {
				return
			}

			if (msg.action === 'auth') {
				try {
					const claims = jwt.verify(String(msg.token ?? ''), config.secret)
					// Link shares get no realtime feed: the events carry data from
					// across a user's projects, not just the shared one.
					if (claims.type !== 1 || !claims.id) {
						throw new Error('not a user token')
					}
					socket.userId = claims.id
					add(claims.id, socket)
					clearTimeout(authTimer)
					socket.send(JSON.stringify({action: 'auth.success', success: true}))
				} catch {
					socket.send(JSON.stringify({error: 'invalid_token'}))
					socket.close()
				}
				return
			}

			// Everything past this point needs an authenticated socket.
			if (!socket.userId) {
				socket.send(JSON.stringify({error: 'auth_required'}))
				return
			}

			if (msg.action === 'subscribe' && typeof msg.event === 'string') {
				socket.subscriptions.add(msg.event)
				// No `event` field in the ack: the client routes any message carrying
				// one to that event's subscribers, so echoing it back would fire the
				// handler with no data attached.
				socket.send(JSON.stringify({action: 'subscribe.success', success: true, subscribed: msg.event}))
			} else if (msg.action === 'unsubscribe' && typeof msg.event === 'string') {
				socket.subscriptions.delete(msg.event)
			}
		})

		const cleanup = () => {
			clearTimeout(authTimer)
			if (socket.userId) {
				remove(socket.userId, socket)
			}
		}
		socket.on('close', cleanup)
		socket.on('error', cleanup)
	})

	console.log('[fsoc] realtime websocket ready on /api/v1/ws')
	return wss
}
