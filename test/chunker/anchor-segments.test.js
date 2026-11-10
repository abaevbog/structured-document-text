import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getAnchorSegments, getRangeSelection } from '../../src/chunker/index.js';
import { pdf, pdfBlock, pdfAnchor, textDocument, restore } from './helpers.js';

const whole = { maxSize: 1000, minSize: 0, overlap: 0 };
// The one chunk a short document cuts into, with its text and its segments,
// and a way to locate ranges of them as a selection
function recover(structure) {
	let [chunk] = getChunks(structure, whole);
	let anchor = () => restore(chunk.anchor);
	return {
		text: getAnchorContent(structure, anchor()).text,
		segments: getAnchorSegments(structure, anchor()),
		locate: ranges => getRangeSelection(structure, ranges),
	};
}
// What the given positions cover, read back as an anchor of their own
const covered = (structure, positions) => getAnchorContent(structure, structure.metadata.processor.type === 'pdf'
	? pdfAnchor(positions) : { selectors: positions })?.text;

// The ranges of the segments between two offsets into the text, one per segment
function rangesAt(segments, start, end) {
	let point = (segment, offset) => [...segment.ref, segment.offset + offset - segment.start];
	return segments.filter(segment => Math.max(start, segment.start) < Math.min(end, segment.end))
		.map(segment => [point(segment, Math.max(start, segment.start)), point(segment, Math.min(end, segment.end))]);
}

describe('the structure of recovered text', () => {
	it('describes each stretch of text by its node and block', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { text, segments } = recover(structure);
		assert.equal(text, 'Owls hunt at night.\n\nHawks hunt by day.');
		assert.deepEqual(segments, [
			{ start: 0, end: 19, ref: [0, 0], offset: 0, blocks: [{ type: 'paragraph', ref: [0] }] },
			{ start: 21, end: 39, ref: [1, 0], offset: 0, blocks: [{ type: 'paragraph', ref: [1] }] },
		]);
	});

	it('keeps the blocks over a node, with a list\'s numbering', () => {
		let structure = textDocument([
			{ type: 'heading', content: [{ text: 'Birds' }] },
			{ type: 'list', ordered: true, startIndex: 3, content: [
				{ type: 'listitem', content: [{ text: 'Owls', style: { bold: true } }] },
				{ type: 'listitem', content: [{ type: 'paragraph', content: [{ text: 'Hawks' }] }] },
			] },
			{ type: 'table', content: [
				{ type: 'tablerow', content: [
					{ type: 'tablecell', header: true, content: [{ type: 'paragraph', content: [{ text: 'Bird' }] }] },
					{ type: 'tablecell', colspan: 2, content: [{ type: 'paragraph', content: [{ text: 'Owl' }] }] },
				] },
			] },
		]);
		let { text, segments } = recover(structure);
		assert.equal(text, 'Birds\n\nOwls\n\nHawks\n\nBird\n\nOwl');
		assert.deepEqual(segments.map(({ blocks, style }) => ({ blocks, style })), [
			{ blocks: [{ type: 'heading', ref: [0] }], style: undefined },
			{ blocks: [{ type: 'list', ref: [1], ordered: true, startIndex: 3 }, { type: 'listitem', ref: [1, 0] }],
				style: { bold: true } },
			{ blocks: [{ type: 'list', ref: [1], ordered: true, startIndex: 3 }, { type: 'listitem', ref: [1, 1] },
				{ type: 'paragraph', ref: [1, 1, 0] }], style: undefined },
			{ blocks: [{ type: 'table', ref: [2] }, { type: 'tablerow', ref: [2, 0] }, { type: 'tablecell', ref: [2, 0, 0] },
				{ type: 'paragraph', ref: [2, 0, 0, 0] }], style: undefined },
			{ blocks: [{ type: 'table', ref: [2] }, { type: 'tablerow', ref: [2, 0] }, { type: 'tablecell', ref: [2, 0, 1] },
				{ type: 'paragraph', ref: [2, 0, 1, 0] }], style: undefined },
		]);
		assert.deepEqual(segments.map(({ start, end }) => text.slice(start, end)), ['Birds', 'Owls', 'Hawks', 'Bird', 'Owl']);
	});

	it('locates ranges as the text they name, read back by its own positions', () => {
		for (let structure of [
			pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]),
			textDocument([{ type: 'paragraph', content: [{ text: 'Owls hunt at night.' }] }, { type: 'paragraph', content: [{ text: 'Hawks hunt by day.' }] }]),
		]) {
			let { text, segments, locate } = recover(structure);
			// Within a node, and across the two, the separator kept
			for (let [start, end] of [[5, 12], [13, 26]]) {
				let found = locate(rangesAt(segments, start, end));
				assert.equal(found.text, text.slice(start, end));
				assert.equal(found.positions.length, 1);
				assert.equal(covered(structure, found.positions), text.slice(start, end));
			}
			// Whitespace at the ends isn't selected
			assert.equal(locate(rangesAt(segments, 4, 10)).text, 'hunt');
		}
	});

	it('selects only the text its ranges name, not what lies between them in the document', () => {
		// A paragraph split by a caption reads whole, the caption after it
		let structure = pdf([
			pdfBlock('Owls hunt at night and', 0, 0, 4, { nextPart: [2] }),
			pdfBlock('Figure 1. An owl.', 0, 0, 2, { type: 'caption', flowClass: 'auxiliary' }),
			pdfBlock('hawks hunt by day.', 0, 0, 0, { previousPart: [0] }),
		]);
		let { text, segments, locate } = recover(structure);
		assert.equal(text, 'Owls hunt at night and hawks hunt by day.\n\nFigure 1. An owl.');
		assert.deepEqual(segments.map(segment => segment.blocks.at(-1).ref), [[0], [2], [1]]);
		// A selection across the parts names the parts' spans alone: the
		// caption between them on the page isn't selected, and the one
		// position's rectangles leave its line out
		let across = locate(rangesAt(segments, 13, 28));
		assert.equal(across.text, 'night and hawks');
		assert.equal(across.positions.length, 1);
		assert.deepEqual(new Set(across.positions[0].rects.map(rect => rect[1])), new Set([4, 0]));
		assert.equal(covered(structure, across.positions), 'night and hawks');
		// Into the caption: everything the chunk reads up to there
		let taken = locate(rangesAt(segments, 13, 49));
		assert.equal(taken.text, 'night and hawks hunt by day.\n\nFigure');
	});

	it('gives nothing for ranges on no text, or on none of it', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.')]);
		let { segments, locate } = recover(structure);
		assert.equal(locate(null), null);
		assert.equal(locate([]), null);
		assert.equal(locate([[[3, 0, 0], [3, 0, 2]]]), null);
		assert.equal(locate(rangesAt(segments, 4, 5)), null);
		assert.equal(locate([[[0, 0, 6], [0, 0, 2]]]), null);
		assert.equal(locate([[[0, 0, 0], [0, 0, 40]]]), null);
		assert.equal(locate([[[0, 0, 4]]]), null);
		assert.equal(locate([[[0, 0], [0, 0, 4]]]), null);
	});

	it('is null for an anchor that does not resolve', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.')]);
		assert.equal(getAnchorSegments(structure, null), null);
		assert.equal(getAnchorSegments(structure, { pageRects: [[7, 0, 0, 1, 1]] }), null);
	});
});
