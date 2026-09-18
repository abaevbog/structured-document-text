import { buildRunData, parseTextMap } from './decode.js';
import { isWhitespaceChar } from './utils.js';
import { compareRefs, getTextNodeSpans, refKey, walkContentRangeLeafBlocks } from '../range.js';

/**
 * Converts between content-tree positions and PDF page positions, using the
 * per-character rects a text node's textMap encodes. A node without one falls
 * back to its own or its block's page rects.
 *
 * Ported from the reader's src/common/sdt/pdf-position-mapper.ts
 */
export class PDFPositionMapper {
	constructor(structure) {
		this._structure = structure;
		this._runDataCache = new Map();
	}

	sdtToSourcePosition(position) {
		return this.textNodeSpansToSourcePosition(getTextNodeSpans(this._structure, position));
	}

	textNodeSpansToSourcePosition(spans) {
		let rectsByPage = new Map();
		let addRect = (pageIndex, rect) => {
			let rects = rectsByPage.get(pageIndex);
			if (!rects) {
				rects = [];
				rectsByPage.set(pageIndex, rects);
			}
			rects.push(rect);
		};

		for (let span of spans) {
			let runData = this._getRunData(span.node, span.ref);
			if (runData) {
				// Run entries correspond to the node's non-whitespace characters
				let runIndex = 0;
				for (let ci = 0; ci < span.node.text.length && runIndex < runData.length; ci++) {
					if (isWhitespaceChar(span.node.text[ci])) continue;
					let run = runData[runIndex++];
					if (ci >= span.start && ci < span.end) {
						addRect(run.pageIndex, run.rect);
					}
				}
			}
			else {
				for (let pageRect of fallbackPageRects(span.node, span.block)) {
					addRect(pageRect[0], pageRect.slice(1, 5));
				}
			}
		}

		if (!rectsByPage.size) return null;

		// nextPageRects are the last page's, with nextPageIndex naming it when
		// it isn't the next page; the pages between contribute nothing. (The
		// reader's copy keeps the second page instead.)
		let pages = [...rectsByPage.keys()].sort((a, b) => a - b);
		let last = pages[pages.length - 1];
		let position = {
			pageIndex: pages[0],
			rects: mergeLineRects(rectsByPage.get(pages[0])),
		};
		if (pages.length > 1) {
			position.nextPageRects = mergeLineRects(rectsByPage.get(last));
			if (last !== pages[0] + 1) {
				position.nextPageIndex = last;
			}
		}
		return position;
	}

	// A position's first and last rects anchor its ends: the range runs from
	// the first character under the start rect to the last under the end
	// rect, whatever lies between. (The reader's copy takes the first and
	// last character under any of the rects, which suits an annotation's
	// many rects but lets a stray glyph under one anchor move the other end.)
	sourceToSDTPosition(position) {
		if (!Number.isInteger(position?.pageIndex) || !position.rects?.length) {
			return null;
		}
		let startRect = position.rects[0];
		let endPage = position.pageIndex;
		let endRect = position.rects[position.rects.length - 1];
		if (position.nextPageRects?.length) {
			endPage = position.nextPageIndex ?? position.pageIndex + 1;
			endRect = position.nextPageRects[position.nextPageRects.length - 1];
		}
		let starts = this._charactersUnder(position.pageIndex, startRect);
		let ends = endRect === startRect ? starts : this._charactersUnder(endPage, endRect);
		if (!starts.length || !ends.length) return null;
		let start = starts[0].start;
		let end = ends[ends.length - 1].end;
		// The end anchor can match an earlier copy of duplicated glyphs
		if (compareRefs(start, end) > 0) return null;
		return { start, end };
	}

	// The characters under a rect on a page, in document order, each as its
	// [start, end) content points. A node with no character rects counts
	// whole when its own or its block's rects intersect.
	_charactersUnder(pageIndex, rect) {
		let found = [];
		let contentRange = this._structure.catalog.pages[pageIndex]?.contentRange;
		if (!contentRange) return found;
		// Page content ranges can start or end mid-block when a block spans
		// pages. Widen to whole blocks and filter by rect.
		let walkRange = [
			[contentRange[0][0]],
			[Math.min(contentRange[1][0] + 1, this._structure.content.length)],
		];
		walkContentRangeTextNodes(this._structure.content, walkRange, (node, ref, block) => {
			let runData = this._getRunData(node, ref);
			if (runData) {
				let runIndex = 0;
				for (let ci = 0; ci < node.text.length && runIndex < runData.length; ci++) {
					if (isWhitespaceChar(node.text[ci])) continue;
					let run = runData[runIndex++];
					if (run.pageIndex === pageIndex && containsCenter(rect, run.rect)) {
						found.push({ start: [...ref, ci], end: [...ref, ci + 1] });
					}
				}
			}
			else {
				let intersects = fallbackPageRects(node, block).some(pageRect => pageRect[0] === pageIndex
					&& quickIntersectRect(rect, pageRect.slice(1, 5)));
				if (intersects) {
					found.push({ start: [...ref, 0], end: [...ref, node.text.length] });
				}
			}
		});
		return found;
	}

	// The position in its stored form: the first and last of its line rects,
	// at a hundredth of a point. A position resolves from the first character
	// under its start rect to the last under its end rect, so the pair bounds
	// the same range the full set does, and a coordinate's trailing digits
	// are float noise.
	compactPosition(position) {
		if (!position?.rects?.length) return position ?? null;
		if (position.nextPageRects?.length) {
			let next = position.nextPageRects;
			let compact = {
				pageIndex: position.pageIndex,
				rects: roundRects([position.rects[0]]),
				nextPageRects: roundRects([next[next.length - 1]]),
			};
			if (position.nextPageIndex !== undefined) {
				compact.nextPageIndex = position.nextPageIndex;
			}
			return compact;
		}
		let rects = position.rects.length < 2
			? position.rects
			: [position.rects[0], position.rects[position.rects.length - 1]];
		return { pageIndex: position.pageIndex, rects: roundRects(rects) };
	}

	expandPosition(compact) {
		return PDFPositionMapper.expandPosition(compact);
	}

	// A compact PDF position is a position already
	static expandPosition(compact) {
		return compact ?? null;
	}

	_getRunData(node, ref) {
		let key = refKey(ref);
		if (this._runDataCache.has(key)) {
			return this._runDataCache.get(key);
		}
		let textMap = node.anchor?.textMap;
		let runData = textMap ? buildRunData(parseTextMap(textMap)) : null;
		if (runData && !runData.length) runData = null;
		this._runDataCache.set(key, runData);
		return runData;
	}
}

// The rects standing in for a node with no character rects, in both
// directions: its own page rects, else its block's when no node of the block
// has a textMap. A block with any character geometry lends its box to none of
// its nodes: the box overlaps neighbouring lines, and a whitespace-only node
// between two runs would smear it over the whole block. (The reader's copy
// substitutes the box for any such node mapping forward, and mapping back has
// no fallback, so it cannot locate a block without character geometry.)
function fallbackPageRects(node, block) {
	let nodeRects = node.anchor?.pageRects;
	if (nodeRects?.length) return nodeRects;
	if (block.content.some(n => n?.anchor?.textMap)) return [];
	return block.anchor?.pageRects ?? [];
}

// Every text node of every leaf block within a content range
function walkContentRangeTextNodes(content, range, callback) {
	walkContentRangeLeafBlocks(content, range, ({ block, ref }) => {
		let nodes = block.content;
		if (!nodes) return;
		for (let i = 0; i < nodes.length; i++) {
			if (typeof nodes[i]?.text === 'string') {
				callback(nodes[i], [...ref, i], block);
			}
		}
	});
}

function roundRects(rects) {
	return rects.map(rect => rect.map(value => Math.round(value * 100) / 100));
}

// A character is under a rect when its center is: glyph boxes are often
// taller than the leading, so a line's rect grazes the lines above and below
// it, and any-overlap would take their characters too. The edge counts, to
// within the stored precision: a glyph with no width or height lies exactly
// on the edge of the line rect it helped make, where rounding and float
// noise cut either way. (The reader's copy tests overlap.)
const EDGE_TOLERANCE = 0.01;

function containsCenter(rect, charRect) {
	let x = (charRect[0] + charRect[2]) / 2;
	let y = (charRect[1] + charRect[3]) / 2;
	return x >= rect[0] - EDGE_TOLERANCE
		&& x <= rect[2] + EDGE_TOLERANCE
		&& y >= rect[1] - EDGE_TOLERANCE
		&& y <= rect[3] + EDGE_TOLERANCE;
}

function quickIntersectRect(r1, r2) {
	return r2[0] < r1[2]
		&& r2[2] > r1[0]
		&& r2[1] < r1[3]
		&& r2[3] > r1[1];
}

// Per-character rects merged into one rect per visual line
function mergeLineRects(rects) {
	let merged = [];
	let current = null;
	for (let rect of rects) {
		if (current && sameLine(current, rect)) {
			current[0] = Math.min(current[0], rect[0]);
			current[1] = Math.min(current[1], rect[1]);
			current[2] = Math.max(current[2], rect[2]);
			current[3] = Math.max(current[3], rect[3]);
		}
		else {
			current = [...rect];
			merged.push(current);
		}
	}
	return merged;
}

function sameLine(rectA, rectB) {
	let overlap = Math.min(rectA[3], rectB[3]) - Math.max(rectA[1], rectB[1]);
	let minHeight = Math.max(0.001, Math.min(rectA[3] - rectA[1], rectB[3] - rectB[1]));
	return overlap / minHeight >= 0.6;
}
