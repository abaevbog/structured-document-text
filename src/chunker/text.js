import { countChunks, iterateChunks } from './chunks.js';

export const CHUNKER_VERSION = 1;

/**
 * Split an immutable, materialized SDT. No source geometry is decoded.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./text').TextChunk[]}
 */
export function getTextChunks(structure, options) {
	return Array.from(iterateChunks(structure, options, false));
}

/**
 * Count the same selected chunks without constructing outputs or decoding geometry.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {number}
 */
export function getChunkCount(structure, options) {
	return countChunks(structure, options);
}

/**
 * Split plain text with no structure. Blank lines separate paragraphs; a
 * single newline is a wrapped line and a form feed a page break, neither
 * of which ends a paragraph, so both read as a space.
 * @param {string} text
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./text').TextChunk[]}
 */
export function getPlainTextChunks(text, options) {
	if (typeof text !== 'string') throw new TypeError('text must be a string');
	// A paragraph is the text between two blank lines, its wrapped lines
	// joined with spaces. A page break goes first, taking the blank lines
	// around it, so a paragraph continues across pages. The paragraphs are
	// in a format with no source anchors: text selection keeps every node
	// of a format it has no anchor rule for.
	let content = [];
	for (let paragraph of text.replace(/\r\n?/gu, '\n').replace(/\s*\f\s*/gu, ' ').split(/\n[ \t]*\n/u)) {
		let joined = paragraph.split('\n').map(line => line.trim()).filter(Boolean).join(' ');
		if (joined) content.push({ type: 'paragraph', content: [{ text: joined }] });
	}
	return getTextChunks({ metadata: { processor: { type: 'text' } }, catalog: {}, content }, options);
}

/**
 * The sections of a document's chunks as a tree, each with the runs of
 * chunks that hold its text or its subsections'.
 * @param {import('./text').ChunkContent[]} chunks - In order
 * @returns {import('./text').ChunkOutlineEntry[]}
 */
export function getChunkOutline(chunks) {
	let outline = [];
	// The entries by their titles from the outermost
	let entries = new Map();
	chunks.forEach((chunk, index) => {
		for (let { outlinePath } of chunk.sections) {
			// Text before the first outline entry is under an entry without a title
			let titles = outlinePath.length ? outlinePath : [null];
			let siblings = outline;
			titles.forEach((title, depth) => {
				let key = JSON.stringify(titles.slice(0, depth + 1));
				let entry = entries.get(key);
				if (!entry) {
					entry = { title, chunks: [], children: [] };
					entries.set(key, entry);
					siblings.push(entry);
				}
				// The chunk carries on the entry's last run, or starts another
				let run = entry.chunks.at(-1);
				if (run && run[1] >= index - 1) run[1] = index;
				else entry.chunks.push([index, index]);
				siblings = entry.children;
			});
		}
	});
	return outline;
}
