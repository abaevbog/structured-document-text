import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getAnchorSegments, getRangeSelection } from '../../src/chunker/index.js';
import { pdf, pdfBlock, pdfAnchor, textDocument, restore } from './helpers.js';

const whole = { maxSize: 1000, minSize: 0, overlap: 0 };
// The one chunk a short document cuts into, with its text and its segments,
// and a way to locate content ranges in it
function recover(structure) {
	let [chunk] = getChunks(structure, whole);
	let anchor = () => restore(chunk.anchor);
	return {
		text: getAnchorContent(structure, anchor()).text,
		segments: getAnchorSegments(structure, anchor()),
		locate: ranges => getRangeSelection(structure, ranges),
	};
}
// What the given runs of positions cover, read back as an anchor of their own
const covered = (structure, runs) => getAnchorContent(structure, structure.metadata.processor.type === 'pdf'
	? pdfAnchor(runs.flat()) : { selectors: runs.flat() })?.text;

// The content point at an offset into the text, from its segment
function pointAt(segments, offset) {
	let segment = segments.find(segment => offset >= segment.start && offset <= segment.end);
	return [...segment.ref, segment.offset + offset - segment.start];
}
// The content range between two offsets into the text
const rangeAt = (segments, start, end) => [pointAt(segments, start), pointAt(segments, end)];

describe('the structure of recovered text', () => {
	it('describes each stretch of text by its node, block and run', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { text, segments } = recover(structure);
		assert.equal(text, 'Owls hunt at night.\n\nHawks hunt by day.');
		assert.deepEqual(segments, [
			{ start: 0, end: 19, ref: [0, 0], offset: 0, run: 0, block: { type: 'paragraph', ref: [0] }, path: [] },
			{ start: 21, end: 39, ref: [1, 0], offset: 0, run: 0, block: { type: 'paragraph', ref: [1] }, path: [] },
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
		assert.deepEqual(segments.map(({ block, path, style }) => ({ block, path, style })), [
			{ block: { type: 'heading', ref: [0] }, path: [], style: undefined },
			{ block: { type: 'listitem', ref: [1, 0] }, style: { bold: true },
				path: [{ type: 'list', ref: [1], ordered: true, startIndex: 3 }] },
			{ block: { type: 'paragraph', ref: [1, 1, 0] }, style: undefined,
				path: [{ type: 'list', ref: [1], ordered: true, startIndex: 3 }, { type: 'listitem', ref: [1, 1] }] },
			{ block: { type: 'paragraph', ref: [2, 0, 0, 0] }, style: undefined,
				path: [{ type: 'table', ref: [2] }, { type: 'tablerow', ref: [2, 0] }, { type: 'tablecell', ref: [2, 0, 0] }] },
			{ block: { type: 'paragraph', ref: [2, 0, 1, 0] }, style: undefined,
				path: [{ type: 'table', ref: [2] }, { type: 'tablerow', ref: [2, 0] }, { type: 'tablecell', ref: [2, 0, 1] }] },
		]);
		assert.deepEqual(segments.map(({ start, end }) => text.slice(start, end)), ['Birds', 'Owls', 'Hawks', 'Bird', 'Owl']);
	});

	it('locates a range as the text between its points, read back by its own positions', () => {
		for (let structure of [
			pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]),
			textDocument([{ type: 'paragraph', content: [{ text: 'Owls hunt at night.' }] }, { type: 'paragraph', content: [{ text: 'Hawks hunt by day.' }] }]),
		]) {
			let { text, segments, locate } = recover(structure);
			// Within a node, and across the two, the separator kept
			for (let [start, end] of [[5, 12], [13, 26]]) {
				let found = locate([rangeAt(segments, start, end)]);
				assert.equal(found.text, text.slice(start, end));
				assert.equal(found.positions.length, 1);
				assert.equal(covered(structure, found.positions), text.slice(start, end));
			}
			// Whitespace at the ends isn't selected
			assert.equal(locate([rangeAt(segments, 4, 10)]).text, 'hunt');
		}
	});

	it('answers one run per range, in text order', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { segments, locate } = recover(structure);
		let both = locate([rangeAt(segments, 0, 4), rangeAt(segments, 21, 26)]);
		assert.equal(both.text, 'Owls\n\nHawks');
		assert.equal(both.positions.length, 2);
		assert.deepEqual(both.positions.map(run => covered(structure, [run])), ['Owls', 'Hawks']);
	});

	it('numbers runs where reading order leaves the document order', () => {
		// A paragraph split by a caption reads whole, the caption after it
		let structure = pdf([
			pdfBlock('Owls hunt at night and', 0, 0, 4, { nextPart: [2] }),
			pdfBlock('Figure 1. An owl.', 0, 0, 2, { type: 'caption', flowClass: 'auxiliary' }),
			pdfBlock('hawks hunt by day.', 0, 0, 0, { previousPart: [0] }),
		]);
		let { text, segments, locate } = recover(structure);
		assert.equal(text, 'Owls hunt at night and hawks hunt by day.\n\nFigure 1. An owl.');
		assert.deepEqual(segments.map(segment => [segment.block.ref, segment.run]), [[[0], 0], [[2], 1], [[1], 2]]);
		// A selection across the parts is two ranges, one per run, each
		// over its own part: one range between its ends would take the
		// caption in
		let across = locate([rangeAt(segments, 13, 22), rangeAt(segments, 23, 28)]);
		assert.equal(across.text, 'night and hawks');
		assert.deepEqual(across.positions.map(run => covered(structure, [run])), ['night and', 'hawks']);
		let taken = locate([rangeAt(segments, 13, 28)]);
		assert.equal(taken.text, 'night and hawks\n\nFigure 1. An owl.');
	});

	it('gives nothing for a range on no text, or on none of it', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.')]);
		let { segments, locate } = recover(structure);
		assert.equal(locate([]), null);
		assert.equal(locate([[[3, 0, 0], [3, 0, 2]]]), null);
		assert.equal(locate([rangeAt(segments, 4, 5)]), null);
		assert.equal(locate([rangeAt(segments, 6, 2)]), null);
		assert.equal(locate([[[0, 0], [0, 0, 4]]]), null);
		assert.equal(locate([[pointAt(segments, 0)]]), null);
	});

	it('is null for an anchor that does not resolve', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.')]);
		assert.equal(getAnchorSegments(structure, null), null);
		assert.equal(getAnchorSegments(structure, { pageRects: [[7, 0, 0, 1, 1]] }), null);
	});
});
