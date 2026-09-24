import { parseTextMap, visitCharPositions } from '../pdf/decode.js';
import { HEADER_AXIS_DIR_SHIFT, HEADER_DIR_RTL, isVertical } from '../pdf/constants.js';
import { isWhitespaceChar } from '../pdf/utils.js';
import { getContentRangeBlockSpan } from '../range.js';

const RECOVERY_TOLERANCE = 0.01; // PDF points.

// Merge selected glyphs into continuous line segments. PDF chunks only select
// text nodes with character maps; block rectangles are never a text fallback.
export class PDFPositionMapper {
	constructor(document) {
		this.document = document;
		this.cache = new WeakMap();
		this.indexes = new WeakMap();
	}

	toPositions(spans) {
		let pages = new Map();
		let selected = new Map();
		for (let span of spans) {
			if (!selected.has(span.entry)) selected.set(span.entry, []);
			selected.get(span.entry).push(span);
		}
		let omitted = new Map();
		let previousSpan, previousGlyph, line;
		let whitespace = false;
		for (let span of spans) {
			if (!adjacentSpans(previousSpan, span)) { previousGlyph = null; whitespace = false; }
			let offset = previousSpan?.entry === span.entry ? previousSpan.end : span.start;
			previousSpan = span;
			let text = span.entry.node.text;
			if (!/\S/u.test(text.slice(span.start, span.end))) { whitespace = true; continue; }
			let geometry = this._characters(span.entry.node);
			let first = geometry ? lowerOffset(geometry, span.start) : 0;
			if (!geometry?.[first] || geometry[first][5] >= span.end) return null;
			let checkedUntil = first;
			for (let i = first; i < geometry.length && geometry[i][5] < span.end; i++) {
				let glyph = geometry[i];
				let pageIndex = glyph[4], rect = glyph;
				// Character maps omit whitespace, so skipped offsets are spaces.
				whitespace ||= glyph[5] > offset;
				let merge = previousGlyph && continuesLine(line, previousGlyph, glyph, whitespace);
				if (merge) {
					if (!omitted.has(pageIndex)) omitted.set(pageIndex, this._omittedGeometry(pageIndex, selected));
					let intersects = omitted.get(pageIndex);
					// Check a whole candidate run once. A clear final box also
					// proves every growing prefix clear. If it fails, use the
					// original per-glyph checks without repeating this lookahead.
					if (i >= checkedUntil) {
						let candidate = [...line], last = glyph, end = i + 1;
						extendRect(candidate, rect);
						while (end < geometry.length && geometry[end][5] < span.end
							&& continuesLine(candidate, last, geometry[end], geometry[end][5] > last[5] + 1)) {
							last = geometry[end++];
							extendRect(candidate, last);
						}
						checkedUntil = end;
						if (!intersects(candidate)) {
							extendRect(line, candidate);
							previousGlyph = last;
							offset = last[5] + 1;
							whitespace = false;
							i = end - 1;
							continue;
						}
					}
					merge = !intersects(unionRect(line, rect));
				}
				if (merge) {
					extendRect(line, rect);
				}
				else {
					line = rect.slice(0, 4);
					if (!pages.has(pageIndex)) pages.set(pageIndex, []);
					pages.get(pageIndex).push(line);
				}
				previousGlyph = glyph;
				offset = glyph[5] + 1;
				whitespace = false;
			}
			whitespace = offset < span.end;
		}
		return [...pages].map(([pageIndex, rects]) => ({ pageIndex, rects }));
	}

	_pageGeometry(pageIndex) {
		if (this.pageGeometry?.pageIndex === pageIndex) return this.pageGeometry;
		let blocks = getContentRangeBlockSpan(this.document.structure.catalog?.pages?.[pageIndex]?.contentRange, this.document.structure.content.length);
		let entries = blocks ? this.document.entries.slice(this.document.blockStarts[blocks.startIndex],
			this.document.blockStarts[blocks.endIndexExclusive]) : this.document.entries;
		let blockEntries = new Map();
		for (let entry of entries) {
			if (!blockEntries.has(entry.block)) blockEntries.set(entry.block, []);
			blockEntries.get(entry.block).push(entry);
		}
		let rects = [];
		let unbounded = [];
		for (let [block, entries] of blockEntries) {
			let bounds = block.anchor?.pageRects;
			if (bounds?.length && bounds.every(rect => validRect(rect.slice(1)))) {
				for (let [page, ...rect] of bounds) if (page === pageIndex) rects.push({ block, rect });
			}
			else for (let entry of entries) unbounded.push(entry);
		}
		// Retain only one page's index; chunks normally proceed in document order.
		return this.pageGeometry = { pageIndex, blockEntries, unbounded, rects };
	}

	_omittedGeometry(pageIndex, selected) {
		let page = this._pageGeometry(pageIndex);
		let selectedBlocks = new Set([...selected.keys()].map(entry => entry.block));
		let blocks = indexRects(page.rects.filter(({ block }) => !selectedBlocks.has(block)));
		let entries = new Set(page.unbounded);
		for (let block of selectedBlocks) {
			for (let entry of page.blockEntries.get(block) ?? []) entries.add(entry);
		}
		let checks = [];
		for (let entry of entries) {
			if (!/\S/u.test(entry.node.text)) continue;
			let spans = selected.get(entry) ?? [];
			if (spans.some(span => !/\S/u.test(entry.node.text.slice(0, span.start) + entry.node.text.slice(span.end)))) continue;
			let chars = this._characters(entry.node);
			if (!chars?.length) continue;
			if (!this.indexes.has(chars)) this.indexes.set(chars, characterTree(chars));
			checks.push({ chars, tree: this.indexes.get(chars), spans });
		}
		if (!checks.length) return blocks.intersects;
		return rect => {
			if (blocks.intersects(rect)) return true;
			return checks.some(({ chars, tree, spans }) => visitCharacters(tree, chars, rect, pageIndex, () => true, spans));
		};
	}

	toSpans(positions) {
		let pages = new Map();
		for (let [index, position] of positions.entries()) {
			if (!Number.isInteger(position.pageIndex) || position.pageIndex < 0 || 'nextPageIndex' in position) return null;
			let ranges = [[position.pageIndex, position.rects]];
			if (position.nextPageRects !== undefined) ranges.push([position.pageIndex + 1, position.nextPageRects]);
			for (let [page, rects] of ranges) {
				if (!Array.isArray(rects) || !rects.length || !rects.every(validRect)) return null;
				if (!pages.has(page)) pages.set(page, []);
				// Expand only recovery queries, so spatial pruning and center tests
				// tolerate the same small shifts without changing saved rectangles.
				for (let [left, bottom, right, top] of rects) pages.get(page).push({ index, rect: [
					left - RECOVERY_TOLERANCE, bottom - RECOVERY_TOLERANCE,
					right + RECOVERY_TOLERANCE, top + RECOVERY_TOLERANCE,
				] });
			}
		}
		let selected = [];
		let resolved = new Set();
		let visited = new Set();
		let queries = new Map([...pages].map(([page, rects]) => [page, indexRects(rects)]));
		for (let page of pages.keys()) {
			let blocks = getContentRangeBlockSpan(this.document.structure.catalog?.pages?.[page]?.contentRange, this.document.structure.content.length);
			if (!blocks) return null;
			let first = this.document.blockStarts[blocks.startIndex];
			let end = this.document.blockStarts[blocks.endIndexExclusive];
			for (let entry of this.document.entries.slice(first, end)) {
				if (visited.has(entry)) continue;
				visited.add(entry);
				let chars = this._characters(entry.node);
				if (!chars?.length) continue;
				if (!this.indexes.has(chars)) this.indexes.set(chars, characterTree(chars));
				let tree = this.indexes.get(chars);
				let hits;
				let firstHit = chars.length, lastHit = -1;
				for (let [pageIndex, query] of queries) query.visit(tree.rect, target => {
					visitCharacters(tree, chars, target.rect, pageIndex, i => {
						resolved.add(target.index);
						hits ??= new Uint8Array(chars.length);
						hits[i] = 1;
						firstHit = Math.min(firstHit, i); lastHit = Math.max(lastHit, i);
					});
				});
				if (!hits) continue;
				for (let i = firstHit; i <= lastHit; i++) {
					if (!hits[i]) continue;
					let start = chars[i][5];
					while (i < lastHit && hits[i + 1]) i++;
					let end = chars[i][5] + 1;
					while (start > 0 && /\s/u.test(entry.node.text[start - 1])) start--;
					while (end < entry.node.text.length && /\s/u.test(entry.node.text[end])) end++;
					selected.push({ entry, start, end });
				}
			}
		}
		// Individual rectangles may become empty, but every supplied position
		// must still resolve text; otherwise this would silently return a fragment.
		return resolved.size === positions.length ? selected : null;
	}

	_characters(node) {
		if (this.cache.has(node)) return this.cache.get(node);
		if (!node.anchor?.textMap) return null;
		// Compact local glyph tuples: [x1, y1, x2, y2, page, offset, direction].
		// The source representation and Reader positions remain unchanged.
		let state = { chars: [], text: node.text, offset: 0, run: null, direction: 0, vertical: false, validated: false };
		for (let run of parseTextMap(node.anchor.textMap)) {
			if (!Array.isArray(run) || run.length < 6) continue;
			state.run = run;
			state.direction = run[0] & ((3 << HEADER_AXIS_DIR_SHIFT) | HEADER_DIR_RTL);
			state.vertical = isVertical((run[0] >> HEADER_AXIS_DIR_SHIFT) & 3);
			state.validated = false;
			if (!visitCharPositions(run, appendCharacter, true, state)) return null;
		}
		let { text, chars, offset } = state;
		while (offset < text.length && isWhitespaceChar(text[offset])) offset++;
		if (offset !== text.length) return null;
		// Reuse large nodes too: adjacent chunks otherwise repeatedly decode them.
		// Weak keys release geometry together with its source document.
		this.cache.set(node, chars);
		return chars;
	}
}

function appendCharacter(start, end, state) {
	if (!Number.isFinite(start) || !Number.isFinite(end)) return;
	if (start > end) return false;
	let { run, text, chars, direction, vertical, offset } = state;
	if (!state.validated) {
		let acrossStart = run[vertical ? 2 : 3], acrossEnd = run[vertical ? 4 : 5];
		if (!Number.isInteger(run[1]) || run[1] < 0 || !Number.isFinite(acrossStart)
			|| !Number.isFinite(acrossEnd) || acrossStart > acrossEnd) return false;
		state.validated = true;
	}
	while (offset < text.length && isWhitespaceChar(text[offset])) offset++;
	if (offset === text.length) return false;
	chars.push(vertical ? [run[2], start, run[4], end, run[1], offset, direction]
		: [start, run[3], end, run[5], run[1], offset, direction]);
	state.offset = offset + 1;
}

function adjacentSpans(previous, span) {
	if (!previous || previous.entry.block !== span.entry.block) return false;
	if (previous.entry === span.entry) {
		return previous.end <= span.start && !/\S/u.test(span.entry.node.text.slice(previous.end, span.start));
	}
	return span.entry.index === previous.entry.index + 1
		&& !/\S/u.test(previous.entry.node.text.slice(previous.end) + span.entry.node.text.slice(0, span.start));
}

function extendRect(target, rect) {
	target[0] = Math.min(target[0], rect[0]); target[1] = Math.min(target[1], rect[1]);
	target[2] = Math.max(target[2], rect[2]); target[3] = Math.max(target[3], rect[3]);
}

function unionRect(a, b) {
	return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function continuesLine(line, previous, glyph, whitespace) {
	if (previous[6] !== glyph[6] || previous[4] !== glyph[4]) return false;
	let a = previous, b = glyph;
	let along = glyph[6] & 2 ? 1 : 0, across = 1 - along;
	let height = Math.min(a[across + 2] - a[across], b[across + 2] - b[across]);
	let lineHeight = Math.max(line[across + 2] - line[across], b[across + 2] - b[across]);
	let overlap = Math.min(line[across + 2], b[across + 2]) - Math.max(line[across], b[across]);
	let gap = Math.max(a[along], b[along]) - Math.min(a[along + 2], b[along + 2]);
	let spacing = Math.max(height * (whitespace ? 1.5 : 0.5), a[along + 2] - a[along], b[along + 2] - b[along]);
	// Compare the entire segment with the larger height, so tall glyphs and
	// gradual baseline drift cannot grow one rectangle across nearby lines.
	return height > 0 && overlap >= lineHeight * 0.6 && gap <= spacing;
}

// Index omitted geometry once per selected page, rather than scanning every
// omitted block for every glyph. Prefix maxima also handle tall overlapping boxes.
function indexRects(rects) {
	let axis = spreadAxis(rects);
	rects.sort((a, b) => a.rect[axis] - b.rect[axis]);
	let top = -Infinity;
	let tops = rects.map(({ rect }) => top = Math.max(top, rect[axis + 2]));
	return {
		// Merging must not enclose omitted text. Edge-only contact is allowed.
		intersects: rect => scan(rect, false),
		// Recovery includes edge matches, with the existing numerical tolerance.
		visit: (rect, visit) => scan(rect, true, visit),
	};

	function scan([left, bottom, right, top], includeEdges, visit) {
		let minimum = axis ? bottom : left, maximum = axis ? top : right;
		let low = 0, high = rects.length;
		while (low < high) {
			let mid = (low + high) >>> 1;
			if (tops[mid] < minimum - 1e-7) low = mid + 1;
			else high = mid;
		}
		for (let i = low; i < rects.length && rects[i].rect[axis] <= maximum + 1e-7; i++) {
			let { rect } = rects[i];
			if (includeEdges) {
				if (rect[0] <= right + 1e-7 && rect[2] >= left - 1e-7 && rect[1] <= top + 1e-7 && rect[3] >= bottom - 1e-7) visit(rects[i]);
			}
			else if (rect[0] < right && rect[2] > left && rect[1] < top && rect[3] > bottom) return true;
		}
		return false;
	}
}

function spreadAxis(rects) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let width = 0, height = 0;
	for (let { rect } of rects) {
		minX = Math.min(minX, rect[0]); maxX = Math.max(maxX, rect[2]);
		minY = Math.min(minY, rect[1]); maxY = Math.max(maxY, rect[3]);
		width += rect[2] - rect[0]; height += rect[3] - rect[1];
	}
	// Prefer the axis with less overlap, rather than just the wider page axis.
	return (maxX - minX) / (width || 1e-7) > (maxY - minY) / (height || 1e-7) ? 0 : 1;
}

function lowerOffset(chars, offset) {
	let low = 0, high = chars.length;
	while (low < high) {
		let mid = (low + high) >>> 1;
		if (chars[mid][5] < offset) low = mid + 1;
		else high = mid;
	}
	return low;
}

// A source-ordered bounding tree is built once per text node. Whole selected
// subtrees can be skipped without constructing the complement for each chunk.
function characterTree(chars, start = 0, end = chars.length) {
	if (end - start > 16) {
		let middle = (start + end) >>> 1;
		let left = characterTree(chars, start, middle), right = characterTree(chars, middle, end);
		let rect = [...left.rect];
		extendRect(rect, right.rect);
		return { start, end, rect, left, right };
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = start; i < end; i++) {
		let char = chars[i], x = (char[0] + char[2]) / 2, y = (char[1] + char[3]) / 2;
		minX = Math.min(minX, x); maxX = Math.max(maxX, x);
		minY = Math.min(minY, y); maxY = Math.max(maxY, y);
	}
	return { start, end, rect: [minX, minY, maxX, maxY] };
}

function visitCharacters(tree, chars, rect, page, visit, spans) {
	let bounds = tree.rect;
	if (bounds[2] < rect[0] - 1e-7 || bounds[0] > rect[2] + 1e-7
		|| bounds[3] < rect[1] - 1e-7 || bounds[1] > rect[3] + 1e-7
		|| spans?.some(span => span.start <= chars[tree.start][5] && span.end > chars[tree.end - 1][5])) return false;
	if (tree.left) return visitCharacters(tree.left, chars, rect, page, visit, spans)
		|| visitCharacters(tree.right, chars, rect, page, visit, spans);
	for (let i = tree.start; i < tree.end; i++) {
		let char = chars[i];
		if (char[4] === page && !spans?.some(span => char[5] >= span.start && char[5] < span.end)
			&& containsCenter(rect, char) && visit(i)) return true;
	}
	return false;
}

function validRect(rect) {
	return Array.isArray(rect) && rect.length === 4 && Number.isFinite(rect[0]) && Number.isFinite(rect[1])
		&& Number.isFinite(rect[2]) && Number.isFinite(rect[3])
		&& rect[0] <= rect[2] && rect[1] <= rect[3];
}

function containsCenter(rect, charRect) {
	let y = (charRect[1] + charRect[3]) / 2;
	if (y < rect[1] - 1e-7 || y > rect[3] + 1e-7) return false;
	let x = (charRect[0] + charRect[2]) / 2;
	return x >= rect[0] - 1e-7 && x <= rect[2] + 1e-7;
}
