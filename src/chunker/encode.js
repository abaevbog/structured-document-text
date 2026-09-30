// A compact byte form of a chunk's anchor, for storing many of them.
// PDF page rectangles become a delta-coded varint stream in tenths of a
// point, rounded outward so that recovery selects the same glyphs; every
// other anchor is kept as JSON. The first byte names the form.
//
// The rect stream is delta coding with zigzag-mapped LEB128 varints, as in
// Protocol Buffers: each coordinate is stored as its difference from the
// same coordinate of the previous rect, negatives folded to odd numbers
// (zigzag), then written seven bits per byte, low bits first, with the
// high bit set on every byte but the last.
const FORMAT_RECTS = 1;
const FORMAT_JSON = 2;
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
	if (!pages) {
		let json = new TextEncoder().encode(JSON.stringify(anchor));
		let out = new Uint8Array(json.length + 1);
		out[0] = FORMAT_JSON;
		out.set(json, 1);
		return out;
	}
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

/**
 * Decode an anchor written by compactAnchor(). PDF rectangles come back
 * grouped by page, in the order the pages first appeared.
 * @param {Uint8Array} bytes
 * @returns {import('./anchors').ChunkAnchor | null}
 */
export function expandAnchor(bytes) {
	if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError('bytes must be a nonempty Uint8Array');
	if (bytes[0] === FORMAT_JSON) return JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
	if (bytes[0] !== FORMAT_RECTS) throw new TypeError('Unknown compact anchor format');
	let cursor = { bytes, offset: 1 };
	let pageRects = [];
	while (cursor.offset < bytes.length) {
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
