import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getAnchorSegments, getPositionRanges } from '../../src/chunker/index.js';
import { pdf, pdfBlock, dom, restore, selectOffsets } from './helpers.js';
import { discoverFixtures } from '../helpers.js';

const whole = { maxSize: 1000, minSize: 0, overlap: 0 };
// The one chunk a short document cuts into, as a way to make positions by
// selecting from it, and the document's own answer to where positions fall
function recover(structure) {
	let [chunk] = getChunks(structure, whole);
	return {
		select: (start, end) => selectOffsets(structure, restore(chunk.anchor), start, end),
		locate: positions => getPositionRanges(structure, positions),
	};
}
const twoBlocks = () => pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
// A content range over one text node
const range = (ref, start, end) => [[...ref, start], [...ref, end]];

// Content ranges as offsets into a chunk's text, placed by the segment that
// shows that part of the node, the way a render of the chunk marks them;
// ranges on nodes the chunk doesn't show are left out
function textOffsets(segments, ranges) {
	let offsets = [];
	for (let [from, to] of ranges) {
		for (let segment of segments) {
			if (segment.ref.join() !== from.slice(0, -1).join()) continue;
			let start = Math.max(from.at(-1), segment.offset);
			let end = Math.min(to.at(-1), segment.offset + segment.end - segment.start);
			if (start < end) offsets.push({ start: segment.start + start - segment.offset, end: segment.start + end - segment.offset });
		}
	}
	return offsets.sort((a, b) => a.start - b.start);
}

describe('locating positions in the structure', () => {
	it('gives the ranges a selection was made from, one per text node', () => {
		let { select, locate } = recover(twoBlocks());
		let word = select(5, 12);
		assert.deepEqual(locate(word.positions), [[range([0, 0], 5, 12)]]);
		// Across the blocks: a range on each
		let across = select(13, 26);
		assert.deepEqual(locate(across.positions), [[range([0, 0], 13, 19), range([1, 0], 0, 5)]]);
	});

	it('counts a glyph by its center, for Reader rectangles a little inside its stored box', () => {
		let { select, locate } = recover(twoBlocks());
		let word = select(5, 12);
		// The Reader measures exact glyphs, while stored boxes are quantized,
		// so its rectangles can fall short of a glyph's box on any side
		let shrunk = word.positions.map(position => ({
			...position,
			rects: position.rects.map(([left, bottom, right, top]) => [left + 0.05, bottom + 0.02, right - 0.15, top - 0.02])
		}));
		assert.deepEqual(locate(shrunk), [[range([0, 0], 5, 12)]]);
	});

	it('spans a page break through nextPageRects, as the Reader stores one', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.', 0), pdfBlock('Hawks hunt by day.', 1)]);
		let { select, locate } = recover(structure);
		let { positions } = select(13, 26);
		// One selection, over two pages
		assert.equal(positions.length, 2);
		let [first, second] = positions;
		assert.deepEqual(locate([{ ...first, nextPageRects: second.rects }]), [[range([0, 0], 13, 19), range([1, 0], 0, 5)]]);
	});

	it('answers per position, null for one covering none of the text or none at all', () => {
		let { select, locate } = recover(twoBlocks());
		let { positions: [inside] } = select(0, 4);
		let elsewhere = { pageIndex: 0, rects: [[50, 50, 60, 51]] };
		assert.deepEqual(locate([elsewhere, inside, null, {}, { pageIndex: 7, rects: [[0, 0, 1, 1]] }]),
			[null, [range([0, 0], 0, 4)], null, null, null]);
		assert.deepEqual(locate([]), []);
	});

	it('finds DOM positions by their selectors', () => {
		for (let type of ['epub', 'snapshot']) {
			let { select, locate } = recover(dom(['First section text.', 'Second section text.'], type));
			let word = select(6, 13);
			assert.deepEqual(locate(word.positions), [[range([0, 0], 6, 13)]], type);
			let across = select(14, 27);
			assert.deepEqual(locate(across.positions), [[range([0, 0], 14, 19), range([1, 0], 0, 6)]], type);
			assert.deepEqual(locate([{ type: 'TextPositionSelector', start: 500, end: 510 }, null]), [null, null], type);
		}
	});

	for (let { format, name, data } of discoverFixtures()) {
		it(`${format}/${name}: finds real selections where they were made`, () => {
			let crossing = getChunks(data).filter(chunk => chunk.text.includes('\n\n')).slice(0, 4);
			assert.ok(crossing.length, 'Fixture must have chunks spanning blocks');
			for (let chunk of crossing) {
				let { text } = getAnchorContent(data, restore(chunk.anchor));
				let boundary = text.indexOf('\n\n');
				let start = text.lastIndexOf(' ', boundary - 1) + 1;
				let end = text.indexOf(' ', boundary + 2);
				if (end === -1) end = text.length;
				let selection = selectOffsets(data, restore(chunk.anchor), start, end);
				assert.ok(selection?.positions?.length);
				// Where the selection settled once moved off whitespace
				let from = text.indexOf(selection.text, start);
				let to = from + selection.text.length;
				let { positions } = selection;
				let found = getPositionRanges(data, positions);
				assert.ok(found.every(Boolean), `${format}/${name}: ${JSON.stringify(selection.text)} not found`);
				// The ranges as a render of the chunk would mark them
				let offsets = textOffsets(getAnchorSegments(data, restore(chunk.anchor)), found.flat());
				assert.ok(offsets.length, `${format}/${name}: ${JSON.stringify(selection.text)} not on the chunk`);
				let element = positions.some(isElementPosition);
				if (element) {
					assert.ok(offsets[0].start <= from && offsets.at(-1).end >= to,
						`${format}/${name}: element positions of ${JSON.stringify(selection.text)} don't cover it`);
				}
				else {
					// Beyond the selection, only whitespace a glyph's box takes in
					assert.equal(text.slice(Math.min(offsets[0].start, from), from).trim(), '',
						`${format}/${name}: ${JSON.stringify(selection.text)} starts elsewhere`);
					assert.equal(text.slice(to, Math.max(offsets.at(-1).end, to)).trim(), '',
						`${format}/${name}: ${JSON.stringify(selection.text)} ends elsewhere`);
					assert.ok(offsets[0].start <= from && offsets.at(-1).end >= to,
						`${format}/${name}: ${JSON.stringify(selection.text)} not covered`);
				}
			}
		});
	}
	// A position addressing a whole element rather than text in it
	const isElementPosition = position => (position.type === 'CssSelector' && !position.refinedBy)
		|| (position.type === 'FragmentSelector' && !position.value.includes(','));
});
