import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, compactAnchor, expandAnchor } from '../../src/chunker/index.js';
import { discoverFixtures } from '../helpers.js';
import { noOverlap, pdf, pdfBlock, dom, restore } from './helpers.js';

const fixtures = discoverFixtures();

describe('compact anchors', () => {
	it('keeps PDF rectangles within a tenth of a point, outward, and recovers the same text', () => {
		let structure = pdf([pdfBlock('First page text. '.repeat(30), 0, 0.37, 12.25), pdfBlock('Second page text. '.repeat(30), 1, 100.5, 700)]);
		let chunks = getChunks(structure, noOverlap);
		assert.ok(chunks.length > 2);
		for (let chunk of chunks) {
			let bytes = compactAnchor(chunk.anchor);
			assert.ok(bytes instanceof Uint8Array);
			assert.ok(bytes.length < JSON.stringify(chunk.anchor).length / 3, `${bytes.length} bytes`);
			let expanded = expandAnchor(bytes);
			assert.equal(expanded.pageRects.length, chunk.anchor.pageRects.length);
			for (let [i, rect] of expanded.pageRects.entries()) {
				let original = chunk.anchor.pageRects[i];
				assert.equal(rect[0], original[0]);
				assert.ok(rect[1] <= original[1] && rect[1] > original[1] - 0.1 && rect[2] <= original[2] && rect[2] > original[2] - 0.1);
				assert.ok(rect[3] >= original[3] && rect[3] < original[3] + 0.1 && rect[4] >= original[4] && rect[4] < original[4] + 0.1);
			}
			assert.deepEqual(getAnchorContent(structure, expanded), getAnchorContent(structure, restore(chunk.anchor)));
		}
	});

	it('groups rectangles by page and handles negative coordinates and float noise', () => {
		let expanded = expandAnchor(compactAnchor({ pageRects: [[3, -12.34, -5, 0, 2.5], [4, 1, 2, 3, 4], [3, 0, 0, 1, 1]] }));
		assert.deepEqual(expanded, { pageRects: [[3, -12.4, -5, 0, 2.5], [3, 0, 0, 1, 1], [4, 1, 2, 3, 4]] });
		// Float noise is absorbed rather than rounded a whole tenth outward
		assert.deepEqual(expandAnchor(compactAnchor({ pageRects: [[0, 290.70000000000005, 0, 538.5999999999998, 1]] })),
			{ pageRects: [[0, 290.7, 0, 538.6, 1]] });
	});

	it('keeps other anchors exactly, including null and unknown shapes', () => {
		for (let type of ['epub', 'snapshot']) {
			let structure = dom(['Some text here.', 'And a second paragraph of it.'], type);
			for (let chunk of getChunks(structure, noOverlap)) {
				assert.deepEqual(expandAnchor(compactAnchor(chunk.anchor)), restore(chunk.anchor));
			}
		}
		for (let odd of [null, { pageRects: [] }, { pageRects: [[0, 0, 0, 1, 1]], nextPageIndex: 7 },
			{ pageRects: [[0, 0, 0, 1]] }, { selectors: [{ type: 'CssSelector', value: '#p0' }] }]) {
			assert.deepEqual(expandAnchor(compactAnchor(odd)), odd);
		}
	});

	it('rejects what it cannot read', () => {
		assert.throws(() => compactAnchor(undefined), TypeError);
		assert.throws(() => compactAnchor([]), TypeError);
		assert.throws(() => expandAnchor(new Uint8Array([])), TypeError);
		assert.throws(() => expandAnchor(new Uint8Array([9, 1])), TypeError);
		let bytes = compactAnchor({ pageRects: [[0, 0, 0, 100, 100]] });
		assert.throws(() => expandAnchor(bytes.subarray(0, bytes.length - 1)), /Truncated/);
	});

	for (let { format, name, data } of fixtures) {
		it(`${format}/${name}: compact anchors recover every chunk identically`, () => {
			let chunks = getChunks(data, { includeAuxiliary: true });
			assert.ok(chunks.length);
			let json = 0, compact = 0;
			for (let chunk of chunks) {
				let bytes = compactAnchor(chunk.anchor);
				json += JSON.stringify(chunk.anchor).length;
				compact += bytes.length;
				assert.deepEqual(getAnchorContent(data, expandAnchor(bytes)), getAnchorContent(data, restore(chunk.anchor)));
			}
			if (format === 'pdf') assert.ok(compact < json / 3, `${compact} of ${json} bytes`);
		});
	}
});
