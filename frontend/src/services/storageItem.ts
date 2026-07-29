import {AuthenticatedHTTPFactory, apiV2Url} from '@/helpers/fetcher'
import {objectToCamelCase} from '@/helpers/case'

import type {IProject} from '@/modelTypes/IProject'
import type {IStorageItem, StorageItemPreviewKind} from '@/modelTypes/IStorageItem'

// Storage lives only on /api/v2, so these bypass the v1-pinned abstractService
// and convert the snake_case wire shape themselves.

// Previews are fetched whole into memory to carry the auth header, so a hard
// ceiling keeps a large upload from wedging the tab. Downloading still works.
export const PREVIEW_MAX_BYTES = 100 * 1024 * 1024

function base(projectId: IProject['id']): string {
	return apiV2Url(`projects/${projectId}/storage`)
}

function toItem(raw: unknown): IStorageItem {
	return objectToCamelCase(raw as Record<string, unknown>) as IStorageItem
}

export async function getStorageItems(projectId: IProject['id']): Promise<IStorageItem[]> {
	const {data} = await AuthenticatedHTTPFactory().get(base(projectId), {params: {per_page: 250}})
	return (data.items ?? []).map(toItem)
}

export async function addStorageLink(projectId: IProject['id'], url: string, title: string): Promise<IStorageItem> {
	const {data} = await AuthenticatedHTTPFactory().post(base(projectId), {url, title})
	return toItem(data)
}

export async function uploadStorageFiles(projectId: IProject['id'], files: File[]): Promise<string[]> {
	const form = new FormData()
	files.forEach(file => form.append('files', file))

	// The shared instance defaults to application/json, which would override the
	// multipart type; clearing it lets the browser set the header with its
	// boundary. transformRequest keeps axios from re-serialising the FormData.
	const {data} = await AuthenticatedHTTPFactory().post(`${base(projectId)}/upload`, form, {
		headers: {'Content-Type': undefined},
		transformRequest: formData => formData,
	})

	// Per-file failures are reported here rather than failing the whole request.
	return data.errors ?? []
}

export async function renameStorageItem(projectId: IProject['id'], id: IStorageItem['id'], title: string): Promise<IStorageItem> {
	const {data} = await AuthenticatedHTTPFactory().put(`${base(projectId)}/${id}`, {title})
	return toItem(data)
}

export async function deleteStorageItem(projectId: IProject['id'], id: IStorageItem['id']): Promise<void> {
	await AuthenticatedHTTPFactory().delete(`${base(projectId)}/${id}`)
}

/**
 * Which viewer a stored item should open in. Derived from the server-detected
 * mime rather than the file name, so a mislabelled extension cannot pick the
 * renderer. Anything not listed here has no viewer and is download-only.
 */
export function previewKindFor(item: IStorageItem): StorageItemPreviewKind {
	if (item.kind === 'link') {
		return 'link'
	}
	if (!item.file) {
		return 'none'
	}
	if (item.file.size > PREVIEW_MAX_BYTES) {
		return 'too-large'
	}

	const mime = (item.file.mime ?? '').split(';')[0].trim().toLowerCase()
	if (mime === 'application/pdf') {
		return 'pdf'
	}
	if (mime === 'text/plain') {
		return 'text'
	}
	if (mime.startsWith('image/')) {
		return 'image'
	}
	if (mime.startsWith('video/')) {
		return 'video'
	}
	if (mime.startsWith('audio/')) {
		return 'audio'
	}
	return 'none'
}

/**
 * Fetches an item's bytes for in-page rendering. The caller owns the returned
 * object URL and must revoke it, otherwise the blob is pinned for the life of
 * the document.
 */
export async function fetchPreviewObjectUrl(projectId: IProject['id'], item: IStorageItem): Promise<string> {
	const {data} = await AuthenticatedHTTPFactory().get(`${base(projectId)}/${item.id}/preview`, {responseType: 'blob'})
	return window.URL.createObjectURL(data)
}

export async function fetchPreviewText(projectId: IProject['id'], item: IStorageItem): Promise<string> {
	const {data} = await AuthenticatedHTTPFactory().get(`${base(projectId)}/${item.id}/preview`, {responseType: 'text'})
	return typeof data === 'string' ? data : String(data)
}

// Downloads go through the http client so the auth header is applied, then a
// temporary object URL — a plain <a href> would hit the endpoint unauthenticated.
export async function downloadStorageItem(projectId: IProject['id'], item: IStorageItem): Promise<void> {
	const {data} = await AuthenticatedHTTPFactory().get(`${base(projectId)}/${item.id}/download`, {responseType: 'blob'})

	const objectUrl = window.URL.createObjectURL(data)
	const link = document.createElement('a')
	link.href = objectUrl
	link.download = item.file?.name ?? item.title
	document.body.appendChild(link)
	link.click()
	link.remove()
	window.URL.revokeObjectURL(objectUrl)
}
