<template>
	<ProjectWrapper
		class="project-storage"
		:is-loading-project="isLoadingProject"
		:project-id="projectId"
		:view-id
	>
		<template #default>
			<div class="storage-view is-max-width-desktop">
				<Message
					v-if="error !== ''"
					variant="danger"
					class="mb-4"
				>
					{{ error }}
				</Message>

				<!-- Grid: sections only. Adding happens inside a section, so a file
					 always lands somewhere the user is actually looking. -->
				<div
					v-if="openKind === null"
					class="storage-grid"
				>
					<button
						v-for="section in SECTIONS"
						:key="section.kind"
						class="storage-tile"
						type="button"
						@click="openKind = section.kind"
					>
						<span class="storage-tile__icon">
							<Icon :icon="section.icon" />
						</span>
						<span class="storage-tile__label">{{ $t(section.label) }}</span>
						<span class="storage-tile__count">
							{{ $t('project.storage.itemCount', countFor(section.kind)) }}
						</span>
					</button>
				</div>

				<template v-else>
					<div class="storage-header">
						<XButton
							variant="secondary"
							icon="arrow-left"
							@click="openKind = null"
						>
							{{ $t('project.storage.back') }}
						</XButton>
						<h2 class="storage-header__title">
							{{ $t(openSection?.label ?? '') }}
						</h2>
					</div>

					<template v-if="canWrite">
						<div
							v-if="openKind !== 'link'"
							class="storage-drop"
							:class="{'storage-drop--over': isDraggedOver}"
							@dragover.prevent="isDraggedOver = true"
							@dragleave="isDraggedOver = false"
							@drop.prevent="onDrop"
							@click="filePicker?.click()"
						>
							<Icon icon="cloud-upload-alt" />
							<span>{{ uploading ? $t('project.storage.uploading') : $t('project.storage.dropFiles') }}</span>
						</div>
						<input
							ref="filePicker"
							type="file"
							multiple
							class="is-hidden"
							@change="onPick"
						>

						<form
							v-if="openKind === 'link'"
							class="storage-linkform"
							@submit.prevent="onAddLink"
						>
							<input
								v-model="newLinkUrl"
								type="url"
								class="input"
								:placeholder="$t('project.storage.linkUrl')"
								required
							>
							<input
								v-model="newLinkTitle"
								type="text"
								class="input"
								:placeholder="$t('project.storage.linkTitle')"
							>
							<XButton
								:disabled="addingLink"
								@click="onAddLink"
							>
								{{ $t('project.storage.addLink') }}
							</XButton>
						</form>
					</template>

					<Card
						:padding="false"
						:has-content="false"
						class="mt-2"
					>
						<p
							v-if="loading"
							class="storage-empty"
						>
							{{ $t('misc.loading') }}
						</p>
						<p
							v-else-if="openItems.length === 0"
							class="storage-empty"
						>
							{{ $t('project.storage.empty') }}
						</p>
						<table
							v-else
							class="table has-actions is-striped is-hoverable is-fullwidth"
						>
							<tbody>
								<tr
									v-for="item in openItems"
									:key="item.id"
								>
									<td>
										<button
											class="storage-linkbtn"
											type="button"
											@click="previewItem = item"
										>
											{{ item.title }}
										</button>
									</td>
									<td class="storage-meta">
										{{ item.file ? formatFileSize(item.file.size) : item.url }}
									</td>
									<td class="storage-meta">
										{{ formatDateShort(item.created) }}
									</td>
									<td class="storage-actions">
										<XButton
											variant="tertiary"
											icon="pen"
											:aria-label="$t('project.storage.rename')"
											@click="startRename(item)"
										/>
										<XButton
											variant="tertiary"
											icon="trash-alt"
											:aria-label="$t('project.storage.delete')"
											@click="onDelete(item)"
										/>
									</td>
								</tr>
							</tbody>
						</table>
					</Card>
				</template>

				<StoragePreviewModal
					v-if="previewItem !== null"
					:project-id="projectId"
					:item="previewItem"
					@close="previewItem = null"
				/>
			</div>
		</template>
	</ProjectWrapper>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import ProjectWrapper from '@/components/project/ProjectWrapper.vue'
import Card from '@/components/misc/Card.vue'
import Message from '@/components/misc/Message.vue'
import XButton from '@/components/input/Button.vue'
import StoragePreviewModal from '@/components/project/views/StoragePreviewModal.vue'

import {formatDateShort} from '@/helpers/time/formatDate'
import {formatFileSize} from '@/helpers/formatFileSize'
import {useProjectStore} from '@/stores/projects'
import {PERMISSIONS} from '@/constants/permissions'
import {
	addStorageLink,
	deleteStorageItem,
	getStorageItems,
	renameStorageItem,
	uploadStorageFiles,
} from '@/services/storageItem'

import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import type {IProject} from '@/modelTypes/IProject'
import type {IProjectView} from '@/modelTypes/IProjectView'
import type {IStorageItem, StorageItemKind} from '@/modelTypes/IStorageItem'

const props = defineProps<{
	projectId: IProject['id']
	viewId: IProjectView['id']
	isLoadingProject?: boolean
}>()

// Icons are limited to those registered in components/misc/Icon.ts — the
// FontAwesome set is tree-shaken, so an unregistered name renders nothing.
const SECTIONS: {kind: StorageItemKind, label: string, icon: IconProp}[] = [
	{kind: 'document', label: 'project.storage.documents', icon: 'file'},
	{kind: 'link', label: 'project.storage.links', icon: 'link'},
	{kind: 'image', label: 'project.storage.images', icon: 'image'},
	{kind: 'video', label: 'project.storage.videos', icon: 'play'},
]

const {t} = useI18n({useScope: 'global'})
// ProjectWrapper has already loaded the project into the store, so read the
// permission from there rather than firing a second request for it.
const projectStore = useProjectStore()

const items = ref<IStorageItem[]>([])
const openKind = ref<StorageItemKind | null>(null)
const previewItem = ref<IStorageItem | null>(null)
const error = ref('')
const loading = ref(false)
const uploading = ref(false)
const addingLink = ref(false)
const isDraggedOver = ref(false)
const newLinkUrl = ref('')
const newLinkTitle = ref('')
const filePicker = ref<HTMLInputElement | null>(null)

// Read-only members can browse and download but must not see controls that
// would only fail server-side.
const canWrite = computed(() =>
	(projectStore.projects[props.projectId]?.maxPermission ?? PERMISSIONS.READ) > PERMISSIONS.READ)

const byKind = computed(() => {
	const grouped: Record<string, IStorageItem[]> = {}
	items.value.forEach(item => {
		grouped[item.kind] ??= []
		grouped[item.kind].push(item)
	})
	return grouped
})

const openSection = computed(() => SECTIONS.find(s => s.kind === openKind.value))
const openItems = computed(() => openKind.value === null ? [] : byKind.value[openKind.value] ?? [])

function countFor(kind: StorageItemKind): number {
	return byKind.value[kind]?.length ?? 0
}

async function load() {
	loading.value = true
	try {
		items.value = await getStorageItems(props.projectId)
		error.value = ''
	} catch {
		error.value = t('project.storage.loadError')
	} finally {
		loading.value = false
	}
}

// Switching project resets the drill-down, otherwise the new project opens on
// whichever section the previous one was showing.
watch(() => props.projectId, () => {
	openKind.value = null
	previewItem.value = null
	load()
}, {immediate: true})

async function upload(files: File[]) {
	if (files.length === 0) {
		return
	}
	uploading.value = true
	try {
		const failures = await uploadStorageFiles(props.projectId, files)
		error.value = failures.length > 0 ? failures.join(' ') : ''
		await load()
	} catch {
		error.value = t('project.storage.uploadError')
	} finally {
		uploading.value = false
	}
}

function onDrop(event: DragEvent) {
	isDraggedOver.value = false
	upload(Array.from(event.dataTransfer?.files ?? []))
}

function onPick(event: Event) {
	const input = event.target as HTMLInputElement
	upload(Array.from(input.files ?? []))
	// Reset so picking the same file twice in a row still fires change.
	input.value = ''
}

async function onAddLink() {
	if (newLinkUrl.value === '') {
		return
	}
	addingLink.value = true
	try {
		await addStorageLink(props.projectId, newLinkUrl.value, newLinkTitle.value)
		newLinkUrl.value = ''
		newLinkTitle.value = ''
		error.value = ''
		await load()
	} catch {
		error.value = t('project.storage.linkError')
	} finally {
		addingLink.value = false
	}
}

async function startRename(item: IStorageItem) {
	const next = window.prompt(t('project.storage.renamePrompt'), item.title)
	if (next === null || next.trim() === '' || next === item.title) {
		return
	}
	try {
		await renameStorageItem(props.projectId, item.id, next.trim())
		await load()
	} catch {
		error.value = t('project.storage.renameError')
	}
}

async function onDelete(item: IStorageItem) {
	if (!window.confirm(t('project.storage.deleteConfirm', {title: item.title}))) {
		return
	}
	try {
		await deleteStorageItem(props.projectId, item.id)
		if (previewItem.value?.id === item.id) {
			previewItem.value = null
		}
		await load()
	} catch {
		error.value = t('project.storage.deleteError')
	}
}
</script>

<style lang="scss" scoped>
.storage-view {
	padding-top: 1rem;
}

.storage-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 1rem;
}

.storage-tile {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: .25rem;
	padding: 1.5rem;
	min-height: 140px;
	border: 1px solid var(--grey-200);
	border-radius: $radius;
	background: var(--white);
	cursor: pointer;
	transition: border-color $transition, box-shadow $transition;

	&:hover {
		border-color: var(--primary);
		box-shadow: var(--shadow-sm);
	}
}

.storage-tile__icon {
	font-size: 1.5rem;
	color: var(--grey-400);
	margin-bottom: .5rem;
}

.storage-tile__label {
	font-weight: 600;
	color: var(--text);
}

.storage-tile__count {
	font-size: .85rem;
	color: var(--grey-500);
}

.storage-drop {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: .5rem;
	padding: 1.25rem;
	border: 2px dashed var(--grey-300);
	border-radius: $radius;
	color: var(--grey-500);
	cursor: pointer;
	transition: border-color $transition, color $transition;
}

.storage-drop--over {
	border-color: var(--primary);
	color: var(--primary);
}

.storage-linkform {
	display: flex;
	flex-wrap: wrap;
	gap: .5rem;

	.input {
		flex: 1 1 12rem;
	}
}

.storage-header {
	display: flex;
	align-items: center;
	gap: 1rem;
	margin-bottom: 1rem;
}

.storage-header__title {
	font-size: 1.25rem;
	font-weight: 600;
	margin: 0;
}

.storage-empty {
	padding: 2rem;
	text-align: center;
	color: var(--grey-500);
}

.storage-meta {
	color: var(--grey-500);
	font-size: .9rem;
	max-width: 20rem;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.storage-actions {
	width: 1%;
	white-space: nowrap;
}

.storage-linkbtn {
	background: none;
	border: none;
	padding: 0;
	font: inherit;
	color: var(--primary);
	cursor: pointer;
	text-align: left;

	&:hover {
		text-decoration: underline;
	}
}
</style>
