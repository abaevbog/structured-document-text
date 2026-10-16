import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getAnchorSelection, getAnchorOverlaps } from '../../src/chunker/index.js';
import { getDocument, indexSpans, sliceSpans, spanOffsets } from '../../src/chunker/document.js';
import { pdf, pdfBlock, dom, restore } from './helpers.js';
import { discoverFixtures } from '../helpers.js';

const whole = { maxSize: 1000, minSize: 0, overlap: 0 };
// The one chunk a short document cuts into, with ways to select from it and
// to ask where positions fall in it
function recover(structure) {
	let [chunk] = getChunks(structure, whole);
	let anchor = () => restore(chunk.anchor);
	return {
		text: getAnchorContent(structure, anchor()).text,
		select: (start, end) => getAnchorSelection(structure, anchor(), start, end),
		overlaps: positions => getAnchorOverlaps(structure, anchor(), positions),
	};
}
const twoBlocks = () => pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);

describe('finding positions within a recovered chunk', () => {
	it('reverses sliceSpans(): the offsets sliced spans came from, and nothing for spans off the text', () => {
		let structure = twoBlocks();
		let { entries: nodes } = getDocument(structure);
		let spans = nodes.map(entry => ({ entry, start: 0, end: entry.node.text.length }));
		let { text, entries } = indexSpans(spans);
		assert.equal(text, 'Owls hunt at night.\n\nHawks hunt by day.');
		for (let [start, end] of [[5, 12], [13, 26], [0, text.length]]) {
			let sliced = sliceSpans(spans, entries, entries.findIndex(entry => entry.end > start), start, end);
			// A span across the separator comes back as the part on each side
			assert.deepEqual(spanOffsets(entries, sliced), end > 19 && start < 21
				? [{ start, end: 19 }, { start: 21, end }] : [{ start, end }]);
		}
		// Only the part of a span within an indexed one counts
		let [indexed] = indexSpans([{ entry: nodes[0], start: 5, end: 12 }]).entries;
		assert.deepEqual(spanOffsets([indexed], spans), [{ start: 0, end: 7 }]);
		assert.deepEqual(spanOffsets(entries, [{ entry: { index: 99 }, start: 0, end: 1 }]), []);
	});

	it('gives the offsets a selection was made from', () => {
		let { select, overlaps } = recover(twoBlocks());
		let word = select(5, 12);
		assert.deepEqual(overlaps(word.positions.flat()), [[{ start: 5, end: 12 }]]);
		// Across the blocks: one range, the separator between them included
		let across = select(13, 26);
		assert.deepEqual(overlaps(across.positions.flat()), [[{ start: 13, end: 26 }]]);
	});

	it('spans a page break through nextPageRects, as the Reader stores one', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.', 0), pdfBlock('Hawks hunt by day.', 1)]);
		let { select, overlaps } = recover(structure);
		let { positions: [run] } = select(13, 26);
		// One run, over two pages
		assert.equal(run.length, 2);
		let [first, second] = run;
		assert.deepEqual(overlaps([{ ...first, nextPageRects: second.rects }]), [[{ start: 13, end: 26 }]]);
	});

	it('answers per position, null for one covering none of the text or none at all', () => {
		let { select, overlaps } = recover(twoBlocks());
		let { positions: [[inside]] } = select(0, 4);
		let elsewhere = { pageIndex: 0, rects: [[50, 50, 60, 51]] };
		assert.deepEqual(overlaps([elsewhere, inside, null, {}, { pageIndex: 7, rects: [[0, 0, 1, 1]] }]),
			[null, [{ start: 0, end: 4 }], null, null, null]);
		assert.deepEqual(overlaps([]), []);
		assert.equal(getAnchorOverlaps(twoBlocks(), null, [inside]), null);
	});

	it('finds DOM positions by their selectors', () => {
		for (let type of ['epub', 'snapshot']) {
			let { select, overlaps } = recover(dom(['First section text.', 'Second section text.'], type));
			let word = select(6, 13);
			assert.deepEqual(overlaps(word.positions.flat()), [[{ start: 6, end: 13 }]], type);
			let across = select(14, 27);
			assert.deepEqual(overlaps(across.positions.flat()), [[{ start: 14, end: 27 }]], type);
			assert.deepEqual(overlaps([{ type: 'TextPositionSelector', start: 500, end: 510 }, null]), [null, null], type);
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
				let selection = getAnchorSelection(data, restore(chunk.anchor), start, end);
				assert.ok(selection?.positions?.length);
				// Where the selection settled once moved off whitespace
				let from = text.indexOf(selection.text, start);
				let to = from + selection.text.length;
				// Every position's ranges, as one sorted list
				let positions = selection.positions.flat();
				let found = getAnchorOverlaps(data, restore(chunk.anchor), positions);
				assert.ok(found?.every(Boolean), `${format}/${name}: ${JSON.stringify(selection.text)} not found`);
				let ranges = found.flat().sort((a, b) => a.start - b.start);
				let element = positions.some(isElementPosition);
				if (element) {
					assert.ok(ranges[0].start <= from && ranges.at(-1).end >= to,
						`${format}/${name}: element positions of ${JSON.stringify(selection.text)} don't cover it`);
				}
				else {
					assert.equal(ranges[0].start, from, `${format}/${name}: ${JSON.stringify(selection.text)} starts elsewhere`);
					assert.equal(ranges.at(-1).end, to, `${format}/${name}: ${JSON.stringify(selection.text)} ends elsewhere`);
				}
			}
		});
	}
	// A position addressing a whole element rather than text in it
	const isElementPosition = position => (position.type === 'CssSelector' && !position.refinedBy)
		|| (position.type === 'FragmentSelector' && !position.value.includes(','));
});
