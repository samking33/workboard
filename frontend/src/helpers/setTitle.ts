export function setTitle(title : undefined | string) {
	document.title = (typeof title === 'undefined' || title === '')
		? 'FSOC'
		: `${title} | FSOC`
}
