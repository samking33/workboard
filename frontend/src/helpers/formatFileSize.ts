const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Renders a byte count for display, e.g. 1536 -> "1.5 KB".
 */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) {
		return '—'
	}

	let size = bytes
	let unit = 0
	while (size >= 1024 && unit < UNITS.length - 1) {
		size /= 1024
		unit++
	}

	// Whole bytes never need a decimal; everything else reads better with one.
	return `${unit === 0 ? size : size.toFixed(1)} ${UNITS[unit]}`
}
