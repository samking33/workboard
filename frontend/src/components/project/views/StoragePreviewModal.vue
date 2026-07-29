<template>
	<div
		class="storage-preview"
		role="dialog"
		aria-modal="true"
		:aria-label="item.title"
		@click.self="emit('close')"
	>
		<div class="storage-preview__panel">
			<header class="storage-preview__bar">
				<span
					class="storage-preview__title"
					:title="item.title"
				>{{ item.title }}</span>
				<span
					v-if="item.file"
					class="storage-preview__meta"
				>{{ formatFileSize(item.file.size) }}</span>

				<div class="storage-preview__actions">
					<XButton
						v-if="item.kind === 'link'"
						variant="secondary"
						icon="arrow-up-right-from-square"
						:href="item.url"
						target="_blank"
						rel="noopener noreferrer"
					>
						{{ $t('project.storage.openLink') }}
					</XButton>
					<XButton
						v-else
						variant="secondary"
						icon="download"
						:disabled="downloading"
						@click="onDownload"
					>
						{{ $t('project.storage.download') }}
					</XButton>
					<XButton
						variant="tertiary"
						icon="times"
						:aria-label="$t('misc.close')"
						@click="emit('close')"
					/>
				</div>
			</header>

			<div class="storage-preview__body">
				<div
					v-if="loading"
					class="storage-preview__state"
				>
					<span class="is-loading" />
				</div>

				<Message
					v-else-if="error !== ''"
					variant="danger"
				>
					{{ error }}
				</Message>

				<img
					v-else-if="kind === 'image'"
					:src="objectUrl"
					:alt="item.title"
					class="storage-preview__image"
				>

				<!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
				<video
					v-else-if="kind === 'video'"
					:src="objectUrl"
					class="storage-preview__video"
					controls
					preload="metadata"
				/>

				<!-- eslint-disable-next-line vuejs-accessibility/media-has-caption -->
				<audio
					v-else-if="kind === 'audio'"
					:src="objectUrl"
					class="storage-preview__audio"
					controls
				/>

				<!-- The response carries a sandbox CSP, so this frame cannot reach the session. -->
				<iframe
					v-else-if="kind === 'pdf'"
					:src="objectUrl"
					:title="item.title"
					class="storage-preview__frame"
				/>

				<pre
					v-else-if="kind === 'text'"
					class="storage-preview__text"
				>{{ textContent }}</pre>

				<div
					v-else-if="kind === 'link'"
					class="storage-preview__link"
				>
					<Icon icon="link" />
					<a
						:href="item.url"
						target="_blank"
						rel="noopener noreferrer"
					>{{ item.url }}</a>
					<p class="storage-preview__hint">
						{{ $t('project.storage.linkHint') }}
					</p>
				</div>

				<div
					v-else
					class="storage-preview__state"
				>
					<Icon icon="file" />
					<p>
						{{ kind === 'too-large'
							? $t('project.storage.tooLargeToPreview')
							: $t('project.storage.noPreview') }}
					</p>
					<XButton
						icon="download"
						:disabled="downloading"
						@click="onDownload"
					>
						{{ $t('project.storage.download') }}
					</XButton>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'

import Message from '@/components/misc/Message.vue'
import XButton from '@/components/input/Button.vue'
import {formatFileSize} from '@/helpers/formatFileSize'
import {
	downloadStorageItem,
	fetchPreviewObjectUrl,
	fetchPreviewText,
	previewKindFor,
} from '@/services/storageItem'

import type {IProject} from '@/modelTypes/IProject'
import type {IStorageItem} from '@/modelTypes/IStorageItem'

const props = defineProps<{
	projectId: IProject['id']
	item: IStorageItem
}>()

const emit = defineEmits<{
	(e: 'close'): void
}>()

const {t} = useI18n({useScope: 'global'})

const loading = ref(false)
const downloading = ref(false)
const error = ref('')
const objectUrl = ref('')
const textContent = ref('')

const kind = computed(() => previewKindFor(props.item))

function releaseObjectUrl() {
	if (objectUrl.value !== '') {
		window.URL.revokeObjectURL(objectUrl.value)
		objectUrl.value = ''
	}
}

async function load() {
	releaseObjectUrl()
	textContent.value = ''
	error.value = ''

	// link / none / too-large render from the item alone, no fetch needed.
	if (!['image', 'video', 'audio', 'pdf', 'text'].includes(kind.value)) {
		return
	}

	loading.value = true
	try {
		if (kind.value === 'text') {
			textContent.value = await fetchPreviewText(props.projectId, props.item)
		} else {
			objectUrl.value = await fetchPreviewObjectUrl(props.projectId, props.item)
		}
	} catch {
		// Includes the server refusing an unsafe type with 415 — the item is
		// still downloadable, so this is a viewer failure, not a fatal one.
		error.value = t('project.storage.previewFailed')
	} finally {
		loading.value = false
	}
}

async function onDownload() {
	downloading.value = true
	try {
		await downloadStorageItem(props.projectId, props.item)
	} catch {
		error.value = t('project.storage.downloadFailed')
	} finally {
		downloading.value = false
	}
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		emit('close')
	}
}

watch(() => props.item.id, load, {immediate: true})

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
	document.removeEventListener('keydown', onKeydown)
	releaseObjectUrl()
})
</script>

<style lang="scss" scoped>
.storage-preview {
	position: fixed;
	inset: 0;
	z-index: 4000;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 2rem 1rem;
	background: rgba(0, 0, 0, .55);
}

.storage-preview__panel {
	display: flex;
	flex-direction: column;
	width: min(1100px, 100%);
	height: min(85vh, 100%);
	background: var(--white);
	border-radius: $radius;
	overflow: hidden;
}

.storage-preview__bar {
	display: flex;
	align-items: center;
	gap: 1rem;
	padding: .75rem 1rem;
	border-bottom: 1px solid var(--grey-200);
}

.storage-preview__title {
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.storage-preview__meta {
	color: var(--grey-500);
	font-size: .85rem;
	white-space: nowrap;
}

.storage-preview__actions {
	display: flex;
	align-items: center;
	gap: .5rem;
	margin-left: auto;
}

.storage-preview__body {
	flex: 1;
	min-height: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 1rem;
	background: var(--grey-100);
	overflow: auto;
}

.storage-preview__image {
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
}

.storage-preview__video {
	max-width: 100%;
	max-height: 100%;
}

.storage-preview__audio {
	width: min(500px, 100%);
}

.storage-preview__frame {
	width: 100%;
	height: 100%;
	border: 0;
	background: var(--white);
}

.storage-preview__text {
	align-self: stretch;
	width: 100%;
	margin: 0;
	padding: 1rem;
	background: var(--white);
	border-radius: $radius;
	font-size: .85rem;
	white-space: pre-wrap;
	word-break: break-word;
	overflow: auto;
}

.storage-preview__state,
.storage-preview__link {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 1rem;
	color: var(--grey-500);
	text-align: center;
	word-break: break-all;
}

.storage-preview__hint {
	font-size: .85rem;
	margin: 0;
}
</style>
