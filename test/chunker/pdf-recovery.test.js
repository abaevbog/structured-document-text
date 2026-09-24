import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getPositionsText } from '../../src/chunker/index.js';

const pdf = (text, rects) => ({
	metadata: { processor: { type: 'pdf' } },
	catalog: { outline: [], pages: [{ contentRange: [[0], [1]] }] },
	content: [{ type: 'paragraph', anchor: { pageRects: [[0, -100, -100, 100, 100]] },
		content: [{ text, anchor: { textMap: JSON.stringify(rects.map(rect => [0, 0, ...rect])) } }] }],
});

it('recovers a saved PDF position after a boundary glyph shifts slightly', () => {
	let original = pdf('AB', [[0, 0, 10, 1], [10, 0, 10, 1]]);
	let positions = JSON.parse(JSON.stringify(getChunks(original)[0].positions));
	let changed = pdf('AB', [[0, 0, 10, 1], [10.005, 0, 10.005, 1]]);
	assert.equal(getPositionsText(changed, positions), 'AB');
	assert.deepEqual(positions, [{ pageIndex: 0, rects: [[0, 0, 10, 1]] }]);
	assert.deepEqual(getChunks(original)[0].positions, positions);
});

for (let [name, rect] of [
	['zero-width boundary', [2, 0, 2, 1]],
	['overlapping', [1.5, 0, 2.5, 1]],
]) {
	it(`recovers an adjacent ${name} glyph along with a small chunk`, () => {
		let structure = pdf('ABC', [[0, 0, 1, 1], [1, 0, 2, 1], rect]);
		let [chunk] = getChunks(structure, { maxSize: 2, minSize: 0, overlap: 0 });
		assert.equal(chunk.text, 'AB');
		assert.equal(getPositionsText(structure, JSON.parse(JSON.stringify(chunk.positions))), 'ABC');
	});
}

for (let [edge, glyph] of [
	['left', shift => [-shift, 0, -shift, 1]],
	['right', shift => [1 + shift, 0, 1 + shift, 1]],
	['bottom', shift => [0, -shift, 1, -shift]],
	['top', shift => [0, 1 + shift, 1, 1 + shift]],
]) {
	it(`tolerates small center shifts at the PDF rectangle's ${edge} edge only`, () => {
		let positions = [{ pageIndex: 0, rects: [[0, 0, 1, 1]] }];
		// Include enough distant glyphs to exercise the spatial tree as well.
		let distant = Array.from({ length: 32 }, (_, i) => [20 + i, 20, 21 + i, 21]);
		for (let [shift, expected] of [[0.005, 'A'], [0.02, null]]) {
			let structure = pdf('A' + 'B'.repeat(distant.length), [glyph(shift), ...distant]);
			assert.equal(getPositionsText(structure, positions), expected);
		}
		assert.deepEqual(positions, [{ pageIndex: 0, rects: [[0, 0, 1, 1]] }]);
	});
}

it('recovers surviving PDF text when separate saved rectangles become empty', () => {
	let rects = [[0, 0, 1, 1], [20, 0, 21, 1], [40, 0, 41, 1]];
	let positions = JSON.parse(JSON.stringify(getChunks(pdf('ABC', rects))[0].positions));
	assert.deepEqual(positions, [{ pageIndex: 0, rects }]);
	for (let text of ['AC', 'A', 'C', '']) {
		let changed = pdf(text, [...text].map(char => rects['ABC'.indexOf(char)]));
		assert.equal(getPositionsText(changed, positions), text || null);
	}
});

it('requires every supplied PDF position to resolve some text, even on the same page', () => {
	let a = [0, 0, 1, 1], b = [20, 0, 21, 1];
	let positions = [{ pageIndex: 0, rects: [a] }, { pageIndex: 0, rects: [b] }];
	assert.equal(getPositionsText(pdf('AB', [a, b]), positions), 'AB');
	assert.equal(getPositionsText(pdf('A', [a]), positions), null);
	assert.equal(getPositionsText(pdf('B', [b]), positions), null);
	assert.equal(getPositionsText(pdf('A', [a]), [positions[0], positions[0]]), 'A');
});

it('rejects a partly unresolved multi-page selection instead of returning one page', () => {
	let structure = pdf('A', [[0, 0, 1, 1]]);
	structure.content.push({ type: 'paragraph', content: [{ text: 'B', anchor: { textMap: '[[0,1,0,0,1,1]]' } }] });
	structure.catalog.pages = [{ contentRange: [[0], [1]] }, { contentRange: [[1], [2]] }];
	let positions = [{ pageIndex: 0, rects: [[0, 0, 1, 1]] }, { pageIndex: 1, rects: [[20, 0, 21, 1]] }];
	assert.equal(getPositionsText(structure, positions), null);
	positions[1].rects = [[0, 0, 1, 1]];
	assert.equal(getPositionsText(structure, positions), 'A\n\nB');
});
