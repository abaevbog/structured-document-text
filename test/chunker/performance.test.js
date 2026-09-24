import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getPositionsText } from '../../src/chunker/index.js';
import { pdf, pdfBlock, dom } from './helpers.js';

it('decodes an oversized PDF node once across all its chunks', t => {
	let count = 100001;
	let textMap = JSON.stringify([[0, 0, 0, 0, count, 1, ...new Array(count).fill(1)]]);
	let decodes = 0;
	let parse = JSON.parse;
	t.mock.method(JSON, 'parse', (...args) => {
		if (args[0] === textMap) decodes++;
		return parse(...args);
	});
	let structure = pdf([{ type: 'paragraph', content: [{ text: 'a'.repeat(count), anchor: { textMap } }] }]);
	let chunks = getChunks(structure);
	assert.ok(chunks.length > 30);
	assert.equal(decodes, 1);
	for (let chunk of chunks) assert.equal(getPositionsText(structure, chunk.positions), chunk.text);
	assert.equal(decodes, 1);
});

it('recovers a selection containing 150,000 DOM text nodes', () => {
	let count = 150000;
	let structure = dom([''], 'snapshot');
	structure.content[0].content = Array.from({ length: count }, (_, stream) => ({ text: 'a', anchor: { stream } }));
	assert.equal(getPositionsText(structure, [{ type: 'TextPositionSelector', start: 0, end: count }]), 'a'.repeat(count));
});

it('recovers a PDF selection with 200,000 overlapping rectangles', () => {
	let structure = pdf([pdfBlock('A')]);
	let rects = Array.from({ length: 200000 }, () => [0, 0, 1, 1]);
	assert.equal(getPositionsText(structure, [{ pageIndex: 0, rects }]), 'A');
});
