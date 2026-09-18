import {
	buildDomMapIndex,
	findDomMapContaining,
	generateDomMapSelector,
	matchDomMapSelector,
} from './dommap.js';
import { localOriginalToNFC, nfcToOriginalLocal } from '../deltamap.js';
import { compareRefs, getTextNodeSpans, refKey, walkContentRangeLeafBlocks } from '../../range.js';

/**
 * Converts between content-tree positions and snapshot selectors, over an
 * index of every anchored text node's place in the body text stream.
 *
 * Stream offsets are in raw original characters -- the space browser-made
 * TextPositionSelectors are measured in -- while a node's text is
 * whitespace-collapsed and NFC-normalized, so its deltaMap translates
 * between the two.
 *
 * Ported from the reader's src/common/sdt/snapshot-position-mapper.ts
 */
export class SnapshotPositionMapper {
	constructor(structure) {
		this._structure = structure;
		// All anchored text nodes, ordered by stream offset
		this._entries = [];
		this._entriesByRef = new Map();
		this._domMapIndex = buildDomMapIndex(structure.catalog.domMap);
		this._buildIndex();
	}

	sdtToSourcePosition(position) {
		return this.textNodeSpansToSourcePosition(getTextNodeSpans(this._structure, position));
	}

	textNodeSpansToSourcePosition(spans) {
		let start = null;
		let end = null;
		for (let span of spans) {
			let entry = this._entriesByRef.get(refKey(span.ref));
			// A synthetic node (a <br> newline, an image's alt text) has no
			// source text of its own
			if (!entry) continue;
			if (start === null) {
				start = entry.stream + nfcToOriginalLocal(entry.deltaMap, 0, span.start);
			}
			end = entry.stream + nfcToOriginalLocal(entry.deltaMap, 0, span.end);
		}
		if (start === null || end === null || end <= start) return null;
		return this._streamRangeToSelector(start, end);
	}

	sourceToSDTPosition(position) {
		let range = this._selectorToStreamRange(position);
		if (!range) return null;
		let start = this._streamPointToContentPoint(range.start, false);
		let end = range.end === range.start
			? start
			: this._streamPointToContentPoint(range.end, true);
		if (!start || !end || compareRefs(start, end) > 0) return null;
		return { start, end };
	}

	// The position in its stored form: [selector, start, end], with no
	// selector for a body-relative range and no offsets for a whole element
	compactPosition(position) {
		if (!position) return null;
		if (position.type === 'TextPositionSelector') {
			return [null, position.start, position.end];
		}
		if (position.type !== 'CssSelector') return null;
		return position.refinedBy
			? [position.value, position.refinedBy.start, position.refinedBy.end]
			: [position.value];
	}

	expandPosition(compact) {
		return SnapshotPositionMapper.expandPosition(compact);
	}

	// A conversion of form alone, so it needs no structure
	static expandPosition(compact) {
		if (!Array.isArray(compact)) return null;
		let [value, start, end] = compact;
		if (value === null) return { type: 'TextPositionSelector', start, end };
		let selector = { type: 'CssSelector', value };
		if (start !== undefined) {
			selector.refinedBy = { type: 'TextPositionSelector', start, end };
		}
		return selector;
	}

	// The best selector for a stream range: the deepest element containing
	// the whole range, refined by element-relative text positions unless the
	// range covers the element's text exactly
	_streamRangeToSelector(start, end) {
		let containing = this._domMapIndex
			? findDomMapContaining(this._domMapIndex, start, end)
			: null;
		if (!containing) {
			// Only <body> contains the range, and stream offsets are
			// body-relative text positions already
			return { type: 'TextPositionSelector', start, end };
		}
		let value = generateDomMapSelector(containing);
		if (start === containing.node.textStart
				&& end === containing.node.textStart + containing.node.textLength) {
			return { type: 'CssSelector', value };
		}
		return {
			type: 'CssSelector',
			value,
			refinedBy: {
				type: 'TextPositionSelector',
				start: start - containing.node.textStart,
				end: end - containing.node.textStart,
			},
		};
	}

	// A position as a stream range: a CssSelector rooted at any element in
	// the domMap, or a bare body-relative TextPositionSelector
	_selectorToStreamRange(position) {
		if (!position || !('type' in position)) return null;
		if (position.type === 'TextPositionSelector') {
			return { start: position.start, end: position.end };
		}
		if (position.type !== 'CssSelector' || !this._domMapIndex) return null;
		let matched = matchDomMapSelector(this._domMapIndex, position.value);
		if (!matched) return null;
		let refinedBy = position.refinedBy;
		if (refinedBy?.type === 'TextPositionSelector') {
			return {
				start: matched.node.textStart + refinedBy.start,
				end: matched.node.textStart + refinedBy.end,
			};
		}
		return {
			start: matched.node.textStart,
			end: matched.node.textStart + matched.node.textLength,
		};
	}

	// A stream offset as a content point, clamped into the nearest text node
	// when it falls in a gap -- whitespace between blocks, or text the
	// extraction didn't keep
	_streamPointToContentPoint(streamPos, isEnd) {
		let entry = isEnd
			? this._lastEntryStartingBefore(streamPos)
			: this._firstEntryEndingAfter(streamPos);
		if (!entry) return null;
		if (entry.isBlock) return [...entry.ref];
		let localRaw = Math.max(0, Math.min(streamPos - entry.stream, entry.rawLength));
		let localNFC = localOriginalToNFC(entry.deltaMap, 0, localRaw, entry.nfcLength);
		return [...entry.ref, localNFC];
	}

	_firstEntryEndingAfter(streamPos) {
		let entries = this._entries;
		let lo = 0;
		let hi = entries.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if (entries[mid].stream + entries[mid].rawLength <= streamPos) {
				lo = mid + 1;
			}
			else {
				hi = mid;
			}
		}
		return lo < entries.length ? entries[lo] : null;
	}

	_lastEntryStartingBefore(streamPos) {
		let entries = this._entries;
		let lo = 0;
		let hi = entries.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if (entries[mid].stream < streamPos) {
				lo = mid + 1;
			}
			else {
				hi = mid;
			}
		}
		return lo > 0 ? entries[lo - 1] : null;
	}

	_buildIndex() {
		let content = this._structure.content;
		walkContentRangeLeafBlocks(content, [[0], [content.length]], ({ block, ref }) => {
			let addedTextEntry = false;
			let nodes = block.content;
			if (nodes) {
				for (let i = 0; i < nodes.length; i++) {
					let node = nodes[i];
					if (typeof node?.text !== 'string') continue;
					let anchor = node.anchor;
					if (typeof anchor?.stream !== 'number') continue;
					this._addEntry({
						ref: [...ref, i],
						stream: anchor.stream,
						rawLength: nfcToOriginalLocal(anchor.deltaMap, 0, node.text.length),
						nfcLength: node.text.length,
						deltaMap: anchor.deltaMap,
					});
					addedTextEntry = true;
				}
			}
			if (!addedTextEntry) {
				this._indexTextlessBlock(block, ref);
			}
		});
		this._entries.sort((a, b) => a.stream - b.stream);
	}

	// A leaf block contributing no text of its own -- an image is the common
	// case -- anchored in the stream by its block selector, so that a source
	// position covering it resolves to it rather than being dropped
	_indexTextlessBlock(block, ref) {
		let selectorMap = block.anchor?.selectorMap;
		if (!selectorMap || !this._domMapIndex) return;
		let matched = matchDomMapSelector(this._domMapIndex, selectorMap);
		if (!matched) return;
		this._addEntry({
			ref,
			stream: matched.node.textStart,
			rawLength: matched.node.textLength,
			nfcLength: 0,
			isBlock: true,
		});
	}

	_addEntry(entry) {
		this._entries.push(entry);
		this._entriesByRef.set(refKey(entry.ref), entry);
	}
}
