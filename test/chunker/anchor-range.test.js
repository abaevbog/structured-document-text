import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getAnchorSelection } from '../../src/chunker/index.js';
import { document, paragraph, pdf, pdfBlock, pdfAnchor, dom, restore } from './helpers.js';
import { discoverFixtures } from '../helpers.js';

const whole = { maxSize: 1000, minSize: 0, overlap: 0 };
// The one chunk a short document cuts into, and everything recovered from it
function recover(structure) {
	let [chunk] = getChunks(structure, whole);
	let content = getAnchorContent(structure, restore(chunk.anchor));
	return { chunk, content, select: (start, end) => getAnchorSelection(structure, restore(chunk.anchor), start, end) };
}
// What the given runs of positions cover, read back as an anchor of their own
const covered = (structure, runs) => getAnchorContent(structure, structure.metadata.processor.type === 'pdf'
	? pdfAnchor(runs.flat()) : { selectors: runs.flat() })?.text;

describe('selecting part of a recovered chunk', () => {
	it('reads the text between two offsets, with positions of its own that read back to it', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { content, select } = recover(structure);
		assert.equal(content.text, 'Owls hunt at night.\n\nHawks hunt by day.');
		let part = select(5, 12);
		assert.deepEqual(part, { ...content, text: 'hunt at', positions: part.positions });
		// One run, on one page
		assert.equal(part.positions.length, 1);
		assert.equal(part.positions[0].length, 1);
		assert.equal(part.positions[0][0].pageIndex, 0);
		// One point per glyph in the fixture: the rectangles span the glyphs selected
		let rects = part.positions[0][0].rects;
		assert.equal(Math.min(...rects.map(rect => rect[0])), 5);
		assert.equal(Math.max(...rects.map(rect => rect[2])), 12);
		assert.equal(covered(structure, part.positions), 'hunt at');
	});

	it('spans entries, keeping their separator in the text and a position per line', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { select } = recover(structure);
		let part = select(13, 26);
		assert.equal(part.text, 'night.\n\nHawks');
		// Consecutive blocks: one run, on one page
		assert.equal(part.positions.length, 1);
		assert.equal(part.positions[0].length, 1);
		assert.deepEqual(new Set(part.positions[0][0].rects.map(rect => rect[1])), new Set([0, 2]));
		assert.equal(covered(structure, part.positions), 'night.\n\nHawks');
	});

	it('moves the offsets off separators and surrounding whitespace', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { select } = recover(structure);
		// Into the separator between the blocks, and onto the spaces around a word
		assert.equal(select(19, 24).text, 'Haw');
		assert.equal(select(4, 10).text, 'hunt');
		assert.equal(select(18, 21).text, '.');
		// Nothing left once moved
		assert.equal(select(19, 21), null);
		assert.equal(select(4, 5), null);
	});

	it('reads the whole text for a range covering it, located as recovery locates it', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.'), pdfBlock('Hawks hunt by day.', 0, 0, 2)]);
		let { content, select } = recover(structure);
		let all = select(0, content.text.length);
		assert.deepEqual(all, { ...content, positions: all.positions });
		assert.ok(all.positions?.length);
		assert.equal(covered(structure, all.positions), content.text);
	});

	it('refuses a range that is not whole and in order within the text', () => {
		let structure = pdf([pdfBlock('Owls hunt at night.')]);
		let { select } = recover(structure);
		for (let [start, end] of [[-1, 3], [0, 0], [3, 2], [0, 20], [1.5, 3], ['1', 3], [undefined, 3], [0]]) {
			assert.equal(select(start, end), null, JSON.stringify([start, end]));
		}
		assert.equal(getAnchorSelection(structure, null, 0, 1), null);
	});

	// A paragraph split by a caption, in a DOM format: its parts read
	// together, the caption after them, though the caption sits between them
	function folded(type) {
		let stream = 0, blocks = 0;
		let block = (text, extra) => {
			let i = blocks++;
			let made = type === 'epub'
				? paragraph(text, { anchor: { selectorMap: `/6/2!/4/${2 * (i + 1)}` }, content: [{ text, anchor: { selectorMap: '/1' } }], ...extra })
				: paragraph(text, { anchor: { selectorMap: `#b${i}` }, content: [{ text, anchor: { stream } }], ...extra });
			stream += text.length;
			return made;
		};
		return document([
			block('Owls hunt at night and', { nextPart: [2] }),
			block('Figure 1. An owl.', { type: 'caption' }),
			block('hawks hunt by day.', { previousPart: [0] }),
		], type);
	}

	it('keeps DOM runs apart across a fold, where one selector would take in or lose text', () => {
		for (let type of ['epub', 'snapshot']) {
			let structure = folded(type);
			let { content, select } = recover(structure);
			assert.equal(content.text, 'Owls hunt at night and hawks hunt by day.\n\nFigure 1. An owl.', type);
			let text = content.text;
			let at = (from, to) => select(text.indexOf(from), text.indexOf(to) + to.length);
			// From part one into part two, which aren't next to each other
			// in the document: one selector would cover the caption too
			let acrossFold = at('night', 'hawks');
			assert.equal(acrossFold.positions.length, 2, type);
			assert.equal(covered(structure, acrossFold.positions), 'night and hawks', type);
			// From part two into the caption, which runs backwards in the source
			let backwards = at('hawks', 'Figure');
			assert.equal(backwards.positions.length, 2, type);
			assert.equal(covered(structure, backwards.positions), 'hawks hunt by day.\n\nFigure', type);
			// From part one through the caption: one selector would lose part two
			let through = at('and', 'owl');
			assert.equal(through.positions.length, 3, type);
			assert.equal(covered(structure, through.positions), 'and hawks hunt by day.\n\nFigure 1. An owl', type);
			// Within a part, one selector as ever
			assert.equal(at('hunt', 'night').positions.length, 1, type);
		}
	});

	it('keeps PDF runs apart across a fold, each over its own part', () => {
		// The caption's line lies between the parts' lines on the page
		let structure = pdf([
			pdfBlock('Owls hunt at night and', 0, 0, 4, { nextPart: [2] }),
			pdfBlock('Figure 1. An owl.', 0, 0, 2, { type: 'caption' }),
			pdfBlock('hawks hunt by day.', 0, 0, 0, { previousPart: [0] }),
		]);
		let { content, select } = recover(structure);
		assert.equal(content.text, 'Owls hunt at night and hawks hunt by day.\n\nFigure 1. An owl.');
		let text = content.text;
		let acrossFold = select(text.indexOf('night'), text.indexOf('hawks') + 'hawks'.length);
		assert.equal(acrossFold.text, 'night and hawks');
		// Two runs on the one page, each with the rectangles of its own
		// part's line: nothing on the caption's line between them
		assert.equal(acrossFold.positions.length, 2);
		let lines = acrossFold.positions.map(run => new Set(run.flatMap(position => position.rects.map(rect => rect[1]))));
		assert.deepEqual(lines, [new Set([4]), new Set([0])]);
		assert.equal(covered(structure, acrossFold.positions), 'night and hawks');
	});

	for (let { format, name, data } of discoverFixtures()) {
		it(`${format}/${name}: locates selections across blocks of real chunks`, () => {
			// Chunks whose text crosses a block boundary, a few per fixture
			let crossing = getChunks(data).filter(chunk => chunk.text.includes('\n\n')).slice(0, 4);
			assert.ok(crossing.length, 'Fixture must have chunks spanning blocks');
			for (let chunk of crossing) {
				let { text } = getAnchorContent(data, restore(chunk.anchor));
				// From the last word before the first boundary to the first
				// word after it
				let boundary = text.indexOf('\n\n');
				let start = text.lastIndexOf(' ', boundary - 1) + 1;
				let end = text.indexOf(' ', boundary + 2);
				if (end === -1) end = text.length;
				let selected = text.slice(start, end).trim();
				let selection = getAnchorSelection(data, restore(chunk.anchor), start, end);
				assert.ok(selection, `${format}/${name}: ${JSON.stringify(selected)} not located`);
				assert.equal(selection.text, selected);
				assert.ok(selection.positions?.length, `${format}/${name}: no positions for ${JSON.stringify(selected)}`);
				// Positions read back as the text selected, except that
				// synthetic text -- an image's description -- is located by
				// its element and reads back whole
				let readBack = covered(data, selection.positions);
				if (selection.positions.flat().some(isElementPosition)) {
					assert.ok(readBack.includes(selected),
						`${format}/${name}: element positions of ${JSON.stringify(selected)} don't cover it`);
				}
				else {
					assert.equal(readBack, selected,
						`${format}/${name}: positions of ${JSON.stringify(selected)} read back differently`);
				}
			}
		});
	}
	// A position addressing a whole element rather than text in it
	const isElementPosition = position => (position.type === 'CssSelector' && !position.refinedBy)
		|| (position.type === 'FragmentSelector' && !position.value.includes(','));

	it('locates a range of DOM text by one selector spanning it', () => {
		for (let type of ['epub', 'snapshot']) {
			let structure = dom(['First section text.', 'Second section text.'], type);
			let { content, select } = recover(structure);
			assert.equal(content.text, 'First section text.\n\nSecond section text.');
			let word = select(6, 13);
			assert.equal(word.text, 'section');
			assert.equal(word.positions.length, 1);
			assert.equal(covered(structure, word.positions), 'section');
			let across = select(14, 27);
			assert.equal(across.text, 'text.\n\nSecond');
			assert.equal(across.positions.length, 1, type);
			assert.equal(covered(structure, across.positions), 'text.\n\nSecond');
			if (type === 'snapshot') {
				assert.deepEqual(word.positions, [[{ type: 'TextPositionSelector', start: 6, end: 13 }]]);
				assert.deepEqual(across.positions, [[{ type: 'TextPositionSelector', start: 14, end: 25 }]]);
			}
			else {
				assert.equal(word.positions[0][0].value, 'epubcfi(/6/2!/4/2/1,:6,:13)');
			}
		}
	});
});
