/**
 * Determines a file's type from its bytes.
 *
 * The multipart Content-Type is supplied by whoever is uploading, so it cannot
 * decide whether a file is safe to serve inline — a caller could label an HTML
 * payload `image/png` and have it rendered on our own origin. Everything the
 * preview endpoint trusts must come from here instead.
 *
 * Anything not positively identified becomes application/octet-stream, which is
 * not previewable, so unknown content fails closed.
 */

const MAGIC = [
	{mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46]},                  // %PDF
	{mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]},
	{mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff]},
	{mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38]},                        // GIF8
	{mime: 'image/bmp', bytes: [0x42, 0x4d]},                                     // BM
	{mime: 'image/vnd.microsoft.icon', bytes: [0x00, 0x00, 0x01, 0x00]},
	{mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00]},
	{mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a]},
	{mime: 'video/x-matroska', bytes: [0x1a, 0x45, 0xdf, 0xa3]},                  // mkv/webm
	{mime: 'audio/ogg', bytes: [0x4f, 0x67, 0x67, 0x53]},                         // OggS
	{mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33]},                              // ID3
	{mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04]},
]

function startsWith(buf, bytes) {
	if (buf.length < bytes.length) {
		return false
	}
	return bytes.every((b, i) => buf[i] === b)
}

// RIFF containers declare their real type at offset 8.
function riffType(buf) {
	if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') {
		return null
	}
	const tag = buf.toString('ascii', 8, 12)
	if (tag === 'WEBP') {
		return 'image/webp'
	}
	if (tag === 'AVI ') {
		return 'video/x-msvideo'
	}
	if (tag === 'WAVE') {
		return 'audio/wav'
	}
	return null
}

// ISO base media (mp4/mov/m4v) puts 'ftyp' at offset 4.
function isoType(buf) {
	if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') {
		return null
	}
	const brand = buf.toString('ascii', 8, 12)
	return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4'
}

/**
 * True only for bytes that are valid UTF-8 and free of control characters.
 * Markup is deliberately excluded: an HTML or SVG document is text, but serving
 * it inline is what we are trying to prevent.
 */
function looksLikePlainText(buf) {
	if (buf.length === 0) {
		return false
	}

	const sample = buf.subarray(0, 4096)
	const decoded = new TextDecoder('utf-8', {fatal: true})
	let text
	try {
		text = decoded.decode(sample)
	} catch {
		return false
	}

	// Allow tab, newline, carriage return; reject other C0 controls and NUL.
	for (const ch of text) {
		const code = ch.codePointAt(0)
		if (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) {
			return false
		}
	}

	// Refuse anything that opens like a document a browser would parse.
	const head = text.trimStart().slice(0, 512).toLowerCase()
	if (head.startsWith('<')) {
		return false
	}
	if (head.includes('<script') || head.includes('<svg') || head.includes('<!doctype')) {
		return false
	}

	return true
}

/**
 * @param {Buffer} buf file contents
 * @returns {string} a mime type derived only from the bytes
 */
export function sniffMime(buf) {
	const riff = riffType(buf)
	if (riff) {
		return riff
	}

	const iso = isoType(buf)
	if (iso) {
		return iso
	}

	for (const {mime, bytes} of MAGIC) {
		if (startsWith(buf, bytes)) {
			return mime
		}
	}

	if (looksLikePlainText(buf)) {
		return 'text/plain'
	}

	return 'application/octet-stream'
}
