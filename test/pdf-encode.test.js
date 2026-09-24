import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { charsToPreformattedTextNodes } from '../src/pdf/encode.js';
import { buildRunData, parseTextMap } from '../src/pdf/decode.js';

const char = (c, x, y = 0, extra = {}) => ({ c, rect: [x, y, x + 5, y + 10], axisDir: 0, monospace: true, ...extra });
const geometry = node => buildRunData(parseTextMap(node.anchor?.textMap));
const text = nodes => nodes.map(node => node.text).join('');

describe('preformatted PDF text geometry', () => {
	it('preserves source rectangles through indentation, column gaps and style changes', () => {
		const chars = [char('a', 0, 0, { lineBreakAfter: true }),
			char('b', 10, 20, { bold: true }), char('c', 20, 20, { bold: true })];
		const nodes = charsToPreformattedTextNodes(3, chars);
		assert.equal(text(nodes), 'a\n  b c');
		assert.deepEqual(nodes.map(({ anchor, ...node }) => node), [
			{ text: 'a\n  ' }, { text: 'b c', style: { bold: true } },
		]);
		assert.deepEqual(nodes.flatMap(geometry), chars.map(ch => ({ pageIndex: 3, rect: ch.rect, vertical: false })));
		assert.deepEqual(nodes.map(node => geometry(node).length), [1, 2]);
	});

	it('does not assign positions to whitespace or discarded line-end soft hyphens', () => {
		const chars = [char('a', 0), char('-', 5, 0, { softHyphen: true, lineBreakAfter: true }),
			char('b', 0, 20), char(' ', 5, 20), char('c', 10, 20)];
		const nodes = charsToPreformattedTextNodes(0, chars);
		assert.equal(text(nodes), 'a\nb c');
		assert.deepEqual(nodes.flatMap(geometry).map(run => run.rect), [chars[0].rect, chars[2].rect, chars[4].rect]);
		const whitespace = charsToPreformattedTextNodes(0, [char(' \t', 0)]);
		assert.equal(text(whitespace), ' \t');
		assert.ok(whitespace.every(node => !node.anchor));
	});

	it('keeps UTF-16 cluster positions aligned without counting embedded spaces', () => {
		const nodes = charsToPreformattedTextNodes(2, [char('😀', 0), char('a b', 5)]);
		assert.equal(text(nodes), '😀a b');
		assert.deepEqual(nodes.flatMap(geometry).map(run => run.rect), [
			[0, 0, 5, 10], [5, 0, 5, 10], [5, 0, 10, 10], [10, 0, 10, 10],
		]);
	});

	it('preserves source order and direction for RTL and vertical glyphs', () => {
		for (const axisDir of [0, 1, 2, 3]) {
			const chars = [char('א', 10, 0, { rtl: true, axisDir }), char('ב', 0, 20, { rtl: true, axisDir })];
			const nodes = charsToPreformattedTextNodes(1, chars);
			assert.deepEqual(nodes.flatMap(geometry), chars.map(ch => ({ pageIndex: 1, rect: ch.rect, vertical: !!(axisDir % 2) })));
			assert.ok(nodes.flatMap(node => parseTextMap(node.anchor.textMap)).every(run => run[0] === (axisDir << 1) + 8));
		}
	});

	it('omits an incomplete node map instead of shifting later glyph positions', () => {
		const nodes = charsToPreformattedTextNodes(0, [char('a', 0), char('b', 5, 0, { rect: null }),
			char('c', 10), char('d', 15, 0, { bold: true })]);
		assert.equal(text(nodes), 'ab cd');
		assert.equal(nodes[0].anchor, undefined);
		assert.deepEqual(geometry(nodes[1]), [{ pageIndex: 0, rect: [15, 0, 20, 10], vertical: false }]);
	});
});
