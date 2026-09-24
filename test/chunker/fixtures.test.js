import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getPositionsText } from '../../src/chunker/index.js';
import { getTextChunks } from '../../src/chunker/text.js';
import { estimateTokens } from '../../src/chunker/chunks.js';
import { discoverFixtures, isUpdateMode, readExpected, writeExpected } from '../helpers.js';
import { restore } from './helpers.js';

const fixtures = discoverFixtures();

describe('real document fixtures', () => {
	for (let { format, name, data, path } of fixtures) {
		it(`${format}/${name}: every chunk has source positions`, () => {
			let options = { includeAuxiliary: true };
			let chunks = getChunks(data, options);
			assert.ok(chunks.length, 'Fixture must produce chunks');
			assert.deepEqual(chunks.map(({ positions, ...chunk }) => chunk), getTextChunks(data, options));
			assert.deepEqual(getChunks(data), chunks.filter(chunk => !chunk.auxiliary));
			for (let chunk of chunks) {
				assert.ok(estimateTokens(chunk.embedText) <= 768 + 1e-7, 'Complete embedding input exceeds estimated token budget');
				let { positions } = chunk;
				assert.ok(positions.length > 0);
				let text = getPositionsText(data, restore(positions));
				assert.equal(text, chunk.text);
			}
			assert.ok(getTextChunks(data, { maxSize: 2400, includeAuxiliary: true }).every(chunk => chunk.embedText.length <= 2400));
		});
		it(`${format}/${name}: preserves expected chunks, including source positions`, () => {
			// Cover optional auxiliary output too; keep geometry on one line per field.
			let chunks = getChunks(data, { includeAuxiliary: true }).map(chunk => {
				let fields = Object.entries(chunk).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
				return `  {\n${fields.join(',\n')}\n  }`;
			});
			let actual = `[\n${chunks.join(',\n')}\n]\n`;
			if (isUpdateMode()) writeExpected(path, name, 'chunks.json', actual);
			let expected = readExpected(path, name, 'chunks.json');
			assert.notEqual(expected, undefined, `Missing ${format}/${name}.chunks.json (run npm run test:update)`);
			assert.equal(actual, expected);
		});
	}
});

for (const { format, name, data } of fixtures) {
	if (format === 'snapshot' && name === '2') {
		it('snapshot/2: recovers containers extending beyond the extracted article', () => {
			for (let value of [
				'body > div:nth-child(4)', 'body > div:nth-child(4) > div',
				'body > div:nth-child(4) > div > div:nth-child(3)',
				'#content', '#bodyContent', '#mw-content-text',
				'#mw-content-text > div:first-child', '#mwAQ', '#mwCXs',
			]) {
				let text = getPositionsText(data, [{ type: 'CssSelector', value }]);
				let prefix = value === '#mwCXs' ? 'EPIC Pacific Ocean' : 'Pacific Ocean';
				assert.ok(text?.startsWith(prefix), `${value}: missing selected article text`);
			}
		});
	}

	it(`${format}/${name}: recovers small chunks at interior source boundaries`, () => {
		let chunks = getChunks(data, { maxSize: 60, minSize: 0, overlap: 7, includeAuxiliary: true });
		assert.ok(chunks.length, 'Fixture must produce chunks');
		for (let [i, chunk] of chunks.entries()) {
			let where = `${format}/${name} chunk ${i}: ${JSON.stringify(chunk.text)}`;
			assert.ok(chunk.embedText.length <= 60, `${where}: embedding input exceeds character budget`);
			let recovered = getPositionsText(data, restore(chunk.positions));
			assert.equal(typeof recovered, 'string', `${where}: position does not resolve`);
			// Whole-element anchors and overlapping glyphs can recover more text;
			// their exact behavior is covered by focused DOM/PDF recovery tests.
			assert.ok(recovered.includes(chunk.text), `${where}: recovered text is truncated or different`);
		}
	});
}
