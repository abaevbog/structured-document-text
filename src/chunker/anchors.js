import { PDFPositionMapper } from './pdf.js';
import { EPUBPositionMapper } from './epub.js';
import { SnapshotPositionMapper } from './snapshot.js';
import { getChains, getDocument, indexSpans, mergeSpans, readingOrder, sliceSpans, spanOffsets, spansText } from './document.js';
import { iterateChunks, outlinePathAt, pageLabel } from './chunks.js';

const formats = { pdf: PDFPositionMapper, epub: EPUBPositionMapper, snapshot: SnapshotPositionMapper };
const mappers = new WeakMap();

/**
 * Split text and attach source anchors before discarding source spans.
 * DOM element anchors provide locations for synthetic text; PDF text requires text maps.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./anchors').Chunk[]}
 */
export function getChunks(structure, options) {
	let mapper = getMapper(structure);
	if (!mapper) throw new TypeError('Unsupported SDT processor type');
	let chunks = [];
	for (let { spans, ...chunk } of iterateChunks(structure, options)) {
		let anchor;
		if (mapper instanceof PDFPositionMapper) anchor = mapper.toAnchor(spans);
		else {
			let selectors = mapper.toPositions(spans);
			anchor = selectors?.length && selectors.every(Boolean) ? { selectors } : null;
		}
		chunks.push({ ...chunk, anchor });
	}
	return chunks;
}

/**
 * Recover covered text without rerunning the chunker or inclusion policy:
 * the text with the section and page at its first recovered text.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @returns {import('./text').ChunkContent | null}
 */
export function getAnchorContent(structure, anchor) {
	let positions = readAnchor(structure, anchor);
	if (!positions) return null;
	let spans = getMapper(structure)?.toSpans(positions);
	if (!spans?.length) return null;
	return locate(structure, readingOrder(getDocument(structure), mergeSpans(spans)));
}

// The spans' text with the section and page at its start
function locate(structure, spans) {
	let document = getDocument(structure);
	let { entry, start } = spans[0];
	// A later part of a continued paragraph reads in the section its paragraph starts in
	let sectionEntry = document.entries[getChains(document)[entry.index]];
	return { text: spansText(spans), outlinePath: outlinePathAt(structure, sectionEntry.ref),
		pageLabel: pageLabel(structure, entry, start) };
}

/**
 * Retrieve positions that cover the text between two offsets in the content of a chunk.
 * Used to create annotations within the document from text selected in the textual
 * render of the chunk. 
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @param {number} start - Offsets into the recovered text
 * @param {number} end
 * @returns {import('./anchors').AnchorSelection | null}
 */
export function getAnchorSelection(structure, anchor, start, end) {
	let positions = readAnchor(structure, anchor);
	if (!positions) return null;
	let mapper = getMapper(structure);
	let spans = mapper?.toSpans(positions);
	if (!spans?.length) return null;
	let document = getDocument(structure);
	spans = readingOrder(document, mergeSpans(spans));
	let { text, entries } = indexSpans(spans);
	let bounds = clampRange(text, entries, start, end);
	if (!bounds) return null;
	[start, end] = bounds;
	spans = sliceSpans(spans, entries, entries.findIndex(entry => entry.end > start), start, end);
	// Blocks [1, 2, 3] with 2 auxiliary read as [1, 3, 2], so a selection
	// from 1 into 3 is located as two runs, [1] and [3], since they aren't
	// next to each other in the document: one position from 1 to 3 would
	// take in 2 as well
	let runs = splitRuns(document, spans).map(run => mapper.toPositions(run)).filter(run => run?.length);
	return { ...locate(structure, spans), positions: runs.length ? runs : null };
}

// Offsets into recovered text as a selection of it: whole and in order, moved
// off the separators between entries and the whitespace at either end.
function clampRange(text, entries, start, end) {
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) return null;
	// Trimming preformatted whitespace can reach a separator, so go until settled
	let from, to;
	do {
		[from, to] = [start, end];
		let first = entries.find(entry => entry.end > start);
		let last = entries.findLast(entry => entry.start < end);
		if (!first || !last) return null;
		start = Math.max(start, first.start);
		end = Math.min(end, last.end);
		while (start < end && /\s/u.test(text[start])) start++;
		while (end > start && /\s/u.test(text[end - 1])) end--;
		if (start >= end) return null;
	} while (start !== from || end !== to);
	return [start, end];
}

// Spans split where the next one doesn't follow in the document: a run is
// consecutive text nodes, with only whitespace in any passed over
function splitRuns(document, spans) {
	let runs = [];
	let previous;
	for (let span of spans) {
		let contiguous = previous && span.entry.index > previous.entry.index
			&& document.entries.slice(previous.entry.index + 1, span.entry.index).every(entry => !/\S/u.test(entry.node.text));
		if (contiguous) runs.at(-1).push(span);
		else runs.push([span]);
		previous = span;
	}
	return runs;
}

/**
 * Find where positions fall within the covered text, as ranges of offsets
 * into the content of the chunk.
 * Used to mark annotations within the textual preview of a chunk.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @param {import('./anchors').Position[]} positions
 * @returns {Array<import('./anchors').TextRange[] | null> | null} - Null when the anchor doesn't resolve
 */
export function getAnchorOverlaps(structure, anchor, positions) {
	let covering = readAnchor(structure, anchor);
	if (!covering) return null;
	let mapper = getMapper(structure);
	let spans = mapper?.toSpans(covering);
	if (!spans?.length) return null;
	spans = readingOrder(getDocument(structure), mergeSpans(spans));
	let { text, entries } = indexSpans(spans);
	return positions.map((position) => {
		if (!position || typeof position !== 'object') return null;
		let found = mapper.toSpans([position]);
		let ranges = found?.length ? settleRanges(text, spanOffsets(entries, mergeSpans(found))) : [];
		return ranges.length ? ranges : null;
	});
}

// Ranges as a highlight of the text reads: ones meeting across nothing but
// whitespace -- a separator -- joined, and the whitespace at their ends,
// which recovery takes in, left out
function settleRanges(text, ranges) {
	let settled = [];
	for (let range of ranges) {
		let last = settled.at(-1);
		if (last && !/\S/u.test(text.slice(last.end, range.start))) last.end = Math.max(last.end, range.end);
		else settled.push({ ...range });
	}
	for (let range of settled) {
		while (range.start < range.end && /\s/u.test(text[range.start])) range.start++;
		while (range.end > range.start && /\s/u.test(text[range.end - 1])) range.end--;
	}
	return settled.filter(range => range.start < range.end);
}

/**
 * Convert an anchor to ordinary Reader positions. DOM conversion does not
 * certify text recovery; callers must handle getAnchorContent() failure separately.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @returns {import('./anchors').Position[] | null}
 */
export function getAnchorPositions(structure, anchor) {
	let positions = readAnchor(structure, anchor);
	if (!positions) return null;
	return structure.metadata?.processor?.type === 'pdf'
		? getMapper(structure).resolvePositions(positions) : positions;
}

// Validate the envelope and translate it to the existing mapper inputs.
// Group PDF rectangles by page so a missing page cannot silently disappear.
function readAnchor(structure, anchor) {
	if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
			|| 'nextPageRects' in anchor || 'nextPageIndex' in anchor) return null;
	let type = structure.metadata?.processor?.type;
	if (type === 'pdf') {
		if ('selectors' in anchor || !Array.isArray(anchor.pageRects) || !anchor.pageRects.length) return null;
		let pages = new Map();
		for (let rect of anchor.pageRects) {
			if (!Array.isArray(rect) || rect.length !== 5 || !Number.isInteger(rect[0]) || rect[0] < 0
					|| !rect.slice(1).every(Number.isFinite) || rect[1] > rect[3] || rect[2] > rect[4]) return null;
			if (!pages.has(rect[0])) pages.set(rect[0], []);
			pages.get(rect[0]).push(rect.slice(1));
		}
		return [...pages].map(([pageIndex, rects]) => ({ pageIndex, rects }));
	}
	if (type !== 'epub' && type !== 'snapshot' || 'pageRects' in anchor
			|| !Array.isArray(anchor.selectors) || !anchor.selectors.length) return null;
	for (let selector of anchor.selectors) if (!validSelector(selector, type)) return null;
	return anchor.selectors.map(selector => ({ ...selector,
		...(selector.refinedBy ? { refinedBy: { ...selector.refinedBy } } : {}) }));
}

function validSelector(selector, type) {
	if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return false;
	if (type === 'epub') return selector.type === 'FragmentSelector' && typeof selector.value === 'string' && !!selector.value;
	if (selector.type === 'TextPositionSelector') return validTextRange(selector);
	return selector.type === 'CssSelector' && typeof selector.value === 'string' && !!selector.value
		&& (selector.refinedBy == null || validTextRange(selector.refinedBy));
}

function validTextRange(selector) {
	return selector.type === 'TextPositionSelector' && Number.isSafeInteger(selector.start)
		&& Number.isSafeInteger(selector.end) && selector.start >= 0 && selector.end >= selector.start;
}

function getMapper(structure) {
	let type = structure.metadata?.processor?.type;
	let Mapper = Object.hasOwn(formats, type) && formats[type];
	if (!Mapper) return null;
	let document = getDocument(structure);
	if (!mappers.has(document)) {
		mappers.set(document, new Mapper(document));
	}
	return mappers.get(document);
}
