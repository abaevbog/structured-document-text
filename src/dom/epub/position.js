import {
	expandSelectorMap,
	parseSelectorMapEntries,
	resolveSelectorMapRange,
} from './decode.js';
import { localOriginalToNFC } from '../deltamap.js';
import { getTextNodeSpans, walkContentRangeLeafBlocks } from '../../range.js';

// Every CFI selector carries the same conformsTo, so the stored form drops it
const CFI_CONFORMS_TO = 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html';

/**
 * Converts between content-tree positions and EPUB CFIs, over an index of
 * every anchored text node's CFI path. A multi-entry selectorMap -- adjacent
 * DOM text nodes merged into one SDT node -- indexes one path per sub-range,
 * each with its character extent within the node.
 *
 * Ported from the reader's src/common/sdt/epub-position-mapper.ts
 */
export class EPUBPositionMapper {
	constructor(structure) {
		this._structure = structure;
		this._pathEntries = [];
		this._blockEntries = [];
		this._buildIndex();
	}

	sdtToSourcePosition(position) {
		return this.textNodeSpansToSourcePosition(getTextNodeSpans(this._structure, position));
	}

	textNodeSpansToSourcePosition(spans) {
		if (!spans.length) return null;
		let first = spans[0];
		let last = spans[spans.length - 1];
		let start = this._spanPoint(first, first.start);
		let end = this._spanPoint(last, last.end);
		if (!start || !end) return null;
		return resolveSelectorMapRange(
			start.map, start.offset,
			end.map, end.offset,
			start.deltaMap, end.deltaMap
		);
	}

	sourceToSDTPosition(position) {
		if (!position || position.type !== 'FragmentSelector') return null;
		let parsed = parseCFIRange(position.value);
		if (!parsed) return null;
		let start = this._pointToContentPoint(parsed.startPath, parsed.startOffset, false);
		let end = this._pointToContentPoint(parsed.endPath, parsed.endOffset, true);
		if (!start || !end) return null;
		return { start, end };
	}

	// The position in its stored form: the CFI string alone
	compactPosition(position) {
		return position?.type === 'FragmentSelector' ? position.value : null;
	}

	expandPosition(compact) {
		return EPUBPositionMapper.expandPosition(compact);
	}

	// A conversion of form alone, so it needs no structure
	static expandPosition(compact) {
		if (typeof compact !== 'string') return null;
		return { type: 'FragmentSelector', conformsTo: CFI_CONFORMS_TO, value: compact };
	}

	// One CFI point as a content point: by text node path, else by the
	// boundary of the block whose path contains it
	_pointToContentPoint(path, offset, isEnd) {
		let strippedPath = stripAssertions(path);

		for (let entry of this._pathEntries) {
			if (strippedPath !== entry.path) continue;
			// CFI offsets are in original (DOM) space; the text is NFC
			let localOffset = offset === null
				? (isEnd ? entry.length : 0)
				: localOriginalToNFC(entry.deltaMap, entry.nodeCharStart, offset, entry.length);
			return [...entry.ref, entry.nodeCharStart + localOffset];
		}

		for (let entry of this._blockEntries) {
			if (!cfiPathStartsWith(strippedPath, entry.path)) continue;
			return isEnd ? getBlockEndBoundary(entry.ref) : [...entry.ref];
		}

		return null;
	}

	// A span's end as a CFI point: an offset into the node's own path, or for
	// a node with no path of its own -- an image's alt text -- the element at
	// its block's path, with no offset. (The reader's copy gives up on such a
	// span instead.)
	_spanPoint(span, offset) {
		let blockSelectorMap = span.block.anchor?.selectorMap;
		if (!blockSelectorMap) return null;
		let nodeSelectorMap = span.node.anchor?.selectorMap;
		if (typeof nodeSelectorMap !== 'string') {
			return { map: blockSelectorMap, offset: null };
		}
		return {
			map: expandSelectorMap(blockSelectorMap, nodeSelectorMap),
			offset,
			deltaMap: span.node.anchor?.deltaMap,
		};
	}

	_buildIndex() {
		let content = this._structure.content;
		walkContentRangeLeafBlocks(content, [[0], [content.length]], ({ block, ref }) => {
			let blockSelectorMap = block.anchor?.selectorMap;
			if (!blockSelectorMap) return;
			this._blockEntries.push({
				ref,
				path: stripAssertions(blockSelectorMap),
				block,
			});

			let nodes = block.content;
			if (!nodes) return;
			for (let i = 0; i < nodes.length; i++) {
				let node = nodes[i];
				if (typeof node?.text !== 'string') continue;
				let anchor = node.anchor;
				if (typeof anchor?.selectorMap !== 'string') continue;
				let expanded = expandSelectorMap(blockSelectorMap, anchor.selectorMap);
				let nodeRef = [...ref, i];
				let entries = parseSelectorMapEntries(expanded);
				if (entries) {
					let cumulative = 0;
					for (let entry of entries) {
						this._pathEntries.push({
							ref: nodeRef,
							path: stripAssertions(entry.path),
							nodeCharStart: cumulative,
							length: entry.length,
							deltaMap: anchor.deltaMap,
						});
						cumulative += entry.length;
					}
				}
				else {
					this._pathEntries.push({
						ref: nodeRef,
						path: stripAssertions(expanded),
						nodeCharStart: 0,
						length: node.text.length,
						deltaMap: anchor.deltaMap,
					});
				}
			}
		});
	}
}

function stripAssertions(cfiPath) {
	return cfiPath.replace(/\[[^\]]*\]/g, '');
}

// Whether `path` continues into `prefix` at a step boundary, or matches it
function cfiPathStartsWith(path, prefix) {
	if (!path.startsWith(prefix)) return false;
	let next = path.charAt(prefix.length);
	return next === '' || next === '/' || next === ':' || next === '!';
}

function getBlockEndBoundary(ref) {
	let end = [...ref];
	end[end.length - 1]++;
	return end;
}

// An `epubcfi(...)` string as start and end paths with optional character
// offsets; a single-point CFI gives identical start and end
function parseCFIRange(value) {
	let match = value.match(/^epubcfi\((.*)\)$/s);
	if (!match) return null;
	let parts = splitTopLevel(match[1]);
	let startRaw;
	let endRaw;
	if (parts.length === 3) {
		startRaw = parts[0] + parts[1];
		endRaw = parts[0] + parts[2];
	}
	else if (parts.length === 1) {
		startRaw = parts[0];
		endRaw = parts[0];
	}
	else {
		return null;
	}
	let start = splitOffset(startRaw);
	let end = splitOffset(endRaw);
	return {
		startPath: start.path,
		startOffset: start.offset,
		endPath: end.path,
		endOffset: end.offset,
	};
}

// A CFI split on top-level commas, ignoring commas inside [assertions]
function splitTopLevel(value) {
	let parts = [];
	let depth = 0;
	let current = '';
	for (let char of value) {
		if (char === '[') {
			depth++;
		}
		else if (char === ']') {
			depth = Math.max(0, depth - 1);
		}
		else if (char === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

function splitOffset(path) {
	let match = path.match(/^(.*?):(\d+)(?:\[[^\]]*\])?$/s);
	if (match) {
		return { path: match[1], offset: parseInt(match[2]) };
	}
	return { path, offset: null };
}
