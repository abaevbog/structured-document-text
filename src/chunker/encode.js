// A compact byte form of a chunk's anchor, for storing many of them.
// PDF page rectangles become a delta-coded varint stream in tenths of a
// point, rounded outward so that recovery selects the same glyphs. Snapshot
// selectors become a varint stream of text ranges and element selectors,
// and EPUB selectors their bare CFI paths; both round-trip exactly. Any
// other anchor is kept as JSON. The first byte names the form.
//
// The rect stream is delta coding with zigzag-mapped LEB128 varints, as in
// Protocol Buffers: each coordinate is stored as its difference from the
// same coordinate of the previous rect, negatives folded to odd numbers
// (zigzag), then written seven bits per byte, low bits first, with the
// high bit set on every byte but the last.
const FORMAT_RECTS = 1;
const FORMAT_JSON = 2;
const FORMAT_TEXT_RANGES = 3;
const FORMAT_CFIS = 4;
const CFI_SPEC = 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html';
const SCALE = 10;
// Absorbs float noise such as 290.70000000000005 before rounding outward.
const EPSILON = 1e-6;

/**
 * Encode an anchor as bytes. PDF rectangles are kept in tenths of a point;
 * an expanded rectangle can be up to 0.1 pt larger on each side than the
 * original and never smaller. Other anchors round-trip exactly.
 * @param {import('./anchors').ChunkAnchor | null} anchor
 * @returns {Uint8Array}
 */
export function compactAnchor(anchor) {
	if (anchor !== null && (typeof anchor !== 'object' || Array.isArray(anchor))) throw new TypeError('anchor must be an object or null');
	let pages = rectPages(anchor);
	if (pages) return rectBytes(pages);
	let selectors = anchorSelectors(anchor);
	if (selectors?.every(isTextSelector)) return textRangeBytes(selectors);
	if (selectors?.every(isCfiSelector)) return cfiBytes(selectors);
	let json = new TextEncoder().encode(JSON.stringify(anchor));
	let out = new Uint8Array(json.length + 1);
	out[0] = FORMAT_JSON;
	out.set(json, 1);
	return out;
}

/**
 * Decode an anchor written by compactAnchor(). PDF rectangles come back
 * grouped by page, in the order the pages first appeared.
 * @param {Uint8Array} bytes
 * @returns {import('./anchors').ChunkAnchor | null}
 */
export function expandAnchor(bytes) {
	if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError('bytes must be a nonempty Uint8Array');
	let cursor = { bytes, offset: 1 };
	if (bytes[0] === FORMAT_JSON) return JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
	if (bytes[0] === FORMAT_RECTS) return readRects(cursor);
	if (bytes[0] === FORMAT_TEXT_RANGES) return readTextRanges(cursor);
	if (bytes[0] === FORMAT_CFIS) return readCfis(cursor);
	throw new TypeError('Unknown compact anchor format');
}

function rectBytes(pages) {
	let out = [FORMAT_RECTS];
	for (let [pageIndex, rects] of pages) {
		writeVarint(out, pageIndex);
		writeVarint(out, rects.length);
		let previous = [0, 0, 0, 0];
		for (let rect of rects) {
			let scaled = [
				Math.floor(rect[0] * SCALE + EPSILON), Math.floor(rect[1] * SCALE + EPSILON),
				Math.ceil(rect[2] * SCALE - EPSILON), Math.ceil(rect[3] * SCALE - EPSILON),
			];
			for (let i = 0; i < 4; i++) writeVarint(out, zigzag(scaled[i] - previous[i]));
			previous = scaled;
		}
	}
	return Uint8Array.from(out);
}

function readRects(cursor) {
	let pageRects = [];
	while (cursor.offset < cursor.bytes.length) {
		let pageIndex = readVarint(cursor);
		let count = readVarint(cursor);
		let previous = [0, 0, 0, 0];
		for (let n = 0; n < count; n++) {
			let rect = [pageIndex];
			for (let i = 0; i < 4; i++) {
				previous[i] += unzigzag(readVarint(cursor));
				rect.push(previous[i] / SCALE);
			}
			pageRects.push(rect);
		}
	}
	return { pageRects };
}

// Snapshot selectors in order. Each starts with a varint: an even one is a
// text range -- its zigzagged gap from the previous range's end, doubled --
// followed by the range's length; 1 is an element selector, its CSS string
// following, and 3 one refined by an element-relative start and length.
function textRangeBytes(selectors) {
	let out = [FORMAT_TEXT_RANGES];
	let previous = 0;
	for (let selector of selectors) {
		if (selector.type === 'TextPositionSelector') {
			writeVarint(out, zigzag(selector.start - previous) * 2);
			writeVarint(out, selector.end - selector.start);
			previous = selector.end;
		}
		else {
			writeVarint(out, selector.refinedBy ? 3 : 1);
			writeString(out, selector.value);
			if (selector.refinedBy) {
				writeVarint(out, selector.refinedBy.start);
				writeVarint(out, selector.refinedBy.end - selector.refinedBy.start);
			}
		}
	}
	return Uint8Array.from(out);
}

function readTextRanges(cursor) {
	let selectors = [], previous = 0;
	while (cursor.offset < cursor.bytes.length) {
		let head = readVarint(cursor);
		if (head % 2 === 0) {
			let start = previous + unzigzag(head / 2);
			let end = start + readVarint(cursor);
			selectors.push({ type: 'TextPositionSelector', start, end });
			previous = end;
		}
		else if (head === 1 || head === 3) {
			let selector = { type: 'CssSelector', value: readString(cursor) };
			if (head === 3) {
				let start = readVarint(cursor);
				selector.refinedBy = { type: 'TextPositionSelector', start, end: start + readVarint(cursor) };
			}
			selectors.push(selector);
		}
		else throw new TypeError('Unknown compact anchor selector');
	}
	return { selectors };
}

// EPUB selectors as their CFI paths; the type, spec and epubcfi() wrapper
// are the same for every selector.
function cfiBytes(selectors) {
	let out = [FORMAT_CFIS];
	for (let { value } of selectors) writeString(out, value.slice('epubcfi('.length, -1));
	return Uint8Array.from(out);
}

function readCfis(cursor) {
	let selectors = [];
	while (cursor.offset < cursor.bytes.length) {
		selectors.push({ type: 'FragmentSelector', conformsTo: CFI_SPEC, value: `epubcfi(${readString(cursor)})` });
	}
	return { selectors };
}

// One [pageIndex, rects] entry per page a PDF anchor names, in order of first
// appearance, or null when the anchor isn't a plain PDF rectangle anchor.
function rectPages(anchor) {
	if (!anchor || Object.keys(anchor).some(key => key !== 'pageRects') || !Array.isArray(anchor.pageRects) || !anchor.pageRects.length) return null;
	let pages = new Map();
	for (let rect of anchor.pageRects) {
		if (!Array.isArray(rect) || rect.length !== 5 || !Number.isSafeInteger(rect[0]) || rect[0] < 0
				|| !rect.slice(1).every(Number.isFinite) || rect[1] > rect[3] || rect[2] > rect[4]) return null;
		if (!pages.has(rect[0])) pages.set(rect[0], []);
		pages.get(rect[0]).push(rect.slice(1));
	}
	return [...pages];
}

// The selectors of an anchor that holds nothing else, or null. The selector
// checks below admit only what decodes back to the same JSON.
function anchorSelectors(anchor) {
	return hasOnlyKeys(anchor, ['selectors']) && Array.isArray(anchor.selectors) && anchor.selectors.length
		? anchor.selectors : null;
}

function isTextRange(selector) {
	return hasOnlyKeys(selector, ['type', 'start', 'end']) && selector.type === 'TextPositionSelector'
		&& Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
		&& selector.start >= 0 && selector.start <= selector.end;
}

function isTextSelector(selector) {
	if (isTextRange(selector)) return true;
	return selector?.type === 'CssSelector' && isText(selector.value) && !!selector.value
		&& (hasOnlyKeys(selector, ['type', 'value'])
			|| hasOnlyKeys(selector, ['type', 'value', 'refinedBy']) && isTextRange(selector.refinedBy));
}

function isCfiSelector(selector) {
	return hasOnlyKeys(selector, ['type', 'conformsTo', 'value']) && selector.type === 'FragmentSelector'
		&& selector.conformsTo === CFI_SPEC && isText(selector.value)
		&& selector.value.startsWith('epubcfi(') && selector.value.endsWith(')');
}

// A string that survives UTF-8, which lone surrogates do not
function isText(value) {
	return typeof value === 'string' && value.isWellFormed();
}

// Keys in the order the decoders write them, so that a round trip keeps the JSON
function hasOnlyKeys(object, keys) {
	return !!object && typeof object === 'object' && !Array.isArray(object)
		&& Object.keys(object).join() === keys.join();
}

function zigzag(value) {
	return value < 0 ? -2 * value - 1 : 2 * value;
}

function unzigzag(value) {
	return value % 2 ? -(value + 1) / 2 : value / 2;
}

function writeVarint(out, value) {
	while (value >= 128) {
		out.push((value % 128) | 128);
		value = Math.floor(value / 128);
	}
	out.push(value);
}

function readVarint(cursor) {
	let value = 0, factor = 1, byte;
	do {
		if (cursor.offset >= cursor.bytes.length) throw new TypeError('Truncated compact anchor');
		byte = cursor.bytes[cursor.offset++];
		value += (byte & 127) * factor;
		factor *= 128;
	} while (byte & 128);
	return value;
}

function writeString(out, text) {
	let bytes = new TextEncoder().encode(text);
	writeVarint(out, bytes.length);
	for (let byte of bytes) out.push(byte);
}

function readString(cursor) {
	let length = readVarint(cursor);
	if (cursor.offset + length > cursor.bytes.length) throw new TypeError('Truncated compact anchor');
	let text = new TextDecoder().decode(cursor.bytes.subarray(cursor.offset, cursor.offset + length));
	cursor.offset += length;
	return text;
}
