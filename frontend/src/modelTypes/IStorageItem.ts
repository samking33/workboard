import type {IAbstract} from './IAbstract'
import type {IProject} from '@/modelTypes/IProject'
import type {IUser} from '@/modelTypes/IUser'

export const STORAGE_ITEM_KINDS = {
	DOCUMENT: 'document',
	LINK: 'link',
	IMAGE: 'image',
	VIDEO: 'video',
} as const
export type StorageItemKind = typeof STORAGE_ITEM_KINDS[keyof typeof STORAGE_ITEM_KINDS]

/**
 * Which viewer opens for an item. 'none' means the type has no safe in-page
 * renderer and 'too-large' means it would be pulled fully into memory first —
 * both fall back to downloading.
 */
export type StorageItemPreviewKind =
	| 'image'
	| 'video'
	| 'audio'
	| 'pdf'
	| 'text'
	| 'link'
	| 'too-large'
	| 'none'

export interface IStorageItemFile {
	id: number
	name: string
	mime: string
	size: number
}

export interface IStorageItem extends IAbstract {
	id: number
	projectId: IProject['id']
	title: string
	kind: StorageItemKind

	// Set for link items only.
	url: string
	// Set for uploaded items only. The bytes come from the download endpoint.
	file: IStorageItemFile | null

	createdBy: IUser
	created: Date
	updated: Date
}
