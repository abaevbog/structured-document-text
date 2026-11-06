import { PDFPositionMapper } from './pdf.js';
import { EPUBPositionMapper } from './epub.js';
import { SnapshotPositionMapper } from './snapshot.js';
import { getChains, getDocument, indexSpans, mergeSpans, readingOrder, spanOffsets, spansText } from './document.js';
import { iterateChunks, outlinePathAt, pageLabel } from './chunks.js';
import { sameRef } from '../range.js';

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
	let spans = recoverSpans(structure, anchor);
	return spans && contentOf(structure, spans);
}

/**
 * The structure of a recovered chunk's text: each stretch of it that comes
 * from one text node, with the block the node sits in and the blocks
 * around that, so the text can be shown as the document shows it and a
 * selection of it addressed within the structure.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @returns {import('./anchors').TextSegment[] | null}
 */
export function getAnchorSegments(structure, anchor) {
	let spans = recoverSpans(structure, anchor);
	return spans && describeSpans(getDocument(structure), spans);
}

// A recovered anchor's spans in reading order, null when it doesn't resolve
function recoverSpans(structure, anchor) {
	let positions = readAnchor(structure, anchor);
	if (!positions) return null;
	let spans = getMapper(structure)?.toSpans(positions);
	if (!spans?.length) return null;
	return readingOrder(getDocument(structure), mergeSpans(spans));
}

// The indexed text's entries as segments: offsets into the text, the point
// in the structure the segment starts at, the run of document-contiguous
// spans it belongs to, and the leaf block and the blocks over it
function describeSpans(document, spans) {
	let runOf = new Map();
	splitRuns(document, spans).forEach((run, i) => run.forEach(span => runOf.set(span, i)));
	// A block's type and ref, and a list's numbering
	let describe = ({ block, ref }) => ({ type: block.type, ref,
		...(block.ordered != null ? { ordered: block.ordered } : {}),
		...(block.startIndex != null ? { startIndex: block.startIndex } : {}) });
	return indexSpans(spans).entries.map(({ span, index, start, end }) => {
		let { entry } = span;
		let path = [];
		for (let parent = document.blocks[entry.blockIndex].parent; parent !== null; parent = document.blocks[parent].parent) {
			path.unshift(describe(document.blocks[parent]));
		}
		let segment = { start, end, ref: entry.ref, offset: span.start, run: runOf.get(spans[index]) ?? 0,
			block: describe(document.blocks[entry.blockIndex]), path };
		if (entry.node.style) segment.style = entry.node.style;
		return segment;
	});
}

/**
 * Locate content ranges in the structure as a selection: the text they
 * cover and, per range that covers any, the positions in the source that
 * cover it. A range is [start, end], each a content point: a text node's
 * ref with an offset into its text. Used to create annotations within the
 * document from text selected in a render of its structure, one range per
 * run of the selection (see getAnchorSegments()).
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./anchors').ContentRange[]} ranges
 * @returns {import('./anchors').AnchorSelection | null}
 */
export function getRangeSelection(structure, ranges) {
	if (!Array.isArray(ranges) || !ranges.length) return null;
	let document = getDocument(structure);
	let mapper = getMapper(structure);
	if (!mapper) return null;
	let runs = [], all = [];
	for (let range of ranges) {
		let spans = rangeSpans(document, range);
		if (!spans) return null;
		runs.push(spans);
		all.push(...spans);
	}
	if (!all.length) return null;
	let located = readingOrder(document, mergeSpans(all));
	let resolved = runs.map(run => mapper.toPositions(run)).filter(run => run?.length);
	return { ...contentOf(structure, located), positions: resolved.length ? resolved : null };
}

// The spans between a range's points, trimmed of the whitespace at either
// end; null for a point on no text node or an empty range
function rangeSpans(document, range) {
	let point = (value) => {
		if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isInteger)) return null;
		let ref = value.slice(0, -1), offset = value.at(-1);
		let entry = document.entries.find(entry => sameRef(entry.ref, ref));
		return entry && offset >= 0 && offset <= entry.node.text.length ? { entry, offset } : null;
	};
	let [start, end] = Array.isArray(range) && range.length === 2 ? range.map(point) : [null, null];
	if (!start || !end) return null;
	if (start.entry.index > end.entry.index || (start.entry === end.entry && start.offset >= end.offset)) return null;
	let spans = [];
	for (let index = start.entry.index; index <= end.entry.index; index++) {
		let entry = document.entries[index];
		spans.push({ entry, start: entry === start.entry ? start.offset : 0,
			end: entry === end.entry ? end.offset : entry.node.text.length });
	}
	// Whitespace at the ends isn't selected text
	while (spans.length) {
		let first = spans[0], text = first.entry.node.text;
		while (first.start < first.end && /\s/u.test(text[first.start])) first.start++;
		if (first.start < first.end) break;
		spans.shift();
	}
	while (spans.length) {
		let last = spans.at(-1), text = last.entry.node.text;
		while (last.end > last.start && /\s/u.test(text[last.end - 1])) last.end--;
		if (last.end > last.start) break;
		spans.pop();
	}
	return spans;
}

// The spans' text with the section and page at its start
function contentOf(structure, spans) {
	let document = getDocument(structure);
	let { entry, start } = spans[0];
	// A later part of a continued paragraph reads in the section its paragraph starts in
	let sectionEntry = document.entries[getChains(document)[entry.index]];
	return { text: spansText(spans), outlinePath: outlinePathAt(structure, sectionEntry.ref),
		pageLabel: pageLabel(structure, entry, start) };
}

// Spans split where the next one doesn't follow in the document: a run is
// consecutive text nodes, with only whitespace in any passed over. Blocks
// [1, 2, 3] with 2 auxiliary read as [1, 3, 2], so text from 1 into 3 is
// two runs, [1] and [3]: one range from 1 to 3 would take in 2 as well.
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
		// Reader positions come from exact glyph geometry, while stored glyph
		// boxes are quantized and can poke out of a rectangle that covers
		// them, so glyphs count by their centers
		let found = mapper.toSpans([position], { byCenter: true });
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
