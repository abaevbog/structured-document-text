import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPositionMapper, expandPosition } from '../src/position.js';
import { getPassages, getPassagePosition, getPositionText, getBlockRangeText } from '../src/chunker.js';
import { getTextNodeSpans, walkContentRangeLeafBlocks } from '../src/range.js';
import { discoverFixtures, isUpdateMode, readExpected, writeExpected } from './helpers.js';

const fixtures = discoverFixtures();

// The position covering a whole leaf block, for every leaf block
function blockPositions(structure) {
	const positions = [];
	walkContentRangeLeafBlocks(structure.content, [[0], [structure.content.length]], ({ ref }) => {
		positions.push({ start: [...ref], end: [...ref.slice(0, -1), ref[ref.length - 1] + 1] });
	});
	return positions;
}

const wordsOf = (structure, position) => ignoringSpace(getTextNodeSpans(structure, position)
	.map(span => span.node.text.slice(span.start, span.end))
	.join(''));

// Whitespace is dropped rather than collapsed: where a block joins its nested
// blocks is the reconstruction's business, not the position's
const ignoringSpace = text => text.replace(/\s+/g, '');

const tally = () => ({ total: 0, roundTripped: 0, widened: 0, truncated: 0, drifted: 0, noSource: 0, noPosition: 0, blank: 0 });

// The text a source position resolves to
function recover(structure, mapper, source) {
	const position = mapper.sourceToSDTPosition(source);
	if (!position) return null;
	return wordsOf(structure, position);
}

// The text a passage's stored position resolves to
function recoverPassage(structure, position) {
	const found = getPositionText(structure, position);
	return found ? ignoringSpace(found.text) : null;
}

// The structure with only a block range's blocks present, as a pack reader
// materializes one
function partialOf(structure, startBlock, endBlock) {
	const content = new Array(structure.content.length);
	for (let i = startBlock; i <= endBlock; i++) content[i] = structure.content[i];
	return { ...structure, content };
}

function score(counts, want, got) {
	if (got === null) counts.noPosition++;
	else if (got === want) counts.roundTripped++;
	else if (got.includes(want)) counts.widened++;
	else if (want.includes(got)) counts.truncated++;
	else counts.drifted++;
}

describe('createPositionMapper', () => {
	it('rejects a processor it has no mapper for', () => {
		assert.throws(
			() => createPositionMapper({ metadata: { processor: { type: 'djvu' } } }),
			/Unsupported/
		);
	});
});

describe('compactPosition', () => {
	const mapperFor = format => createPositionMapper(fixtures.find(fixture => fixture.format === format).data);

	// [format, name, position, compact, expanded (the position itself when
	// compaction loses nothing)]
	const cases = [
		['epub', 'a CFI as its own string',
			{ type: 'FragmentSelector', conformsTo: 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html', value: 'epubcfi(/6/4!/4/2,/1:0,/3:9)' },
			'epubcfi(/6/4!/4/2,/1:0,/3:9)'],
		['snapshot', 'a refined snapshot selector as a triple',
			{ type: 'CssSelector', value: '#mwhw', refinedBy: { type: 'TextPositionSelector', start: 1280, end: 3989 } },
			['#mwhw', 1280, 3989]],
		['snapshot', 'a whole-element snapshot selector as a single',
			{ type: 'CssSelector', value: '#mwhw' },
			['#mwhw']],
		['snapshot', 'a body-relative range with no element',
			{ type: 'TextPositionSelector', start: 5, end: 9 },
			[null, 5, 9]],
		['pdf', 'a one-page PDF position by its first and last rects, rounded',
			{ pageIndex: 3, rects: [[1.004, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12.996]] },
			{ pageIndex: 3, rects: [[1, 2, 3, 4], [9, 10, 11, 13]] },
			{ pageIndex: 3, rects: [[1, 2, 3, 4], [9, 10, 11, 13]] }],
		['pdf', 'a two-page PDF position by its first rect and its last on the next page',
			{ pageIndex: 3, rects: [[1, 2, 3, 4], [5, 6, 7, 8]], nextPageRects: [[9, 10, 11, 12], [13, 14, 15, 16]] },
			{ pageIndex: 3, rects: [[1, 2, 3, 4]], nextPageRects: [[13, 14, 15, 16]] },
			{ pageIndex: 3, rects: [[1, 2, 3, 4]], nextPageRects: [[13, 14, 15, 16]] }],
		['pdf', 'a PDF position ending pages later, with the page its end is on',
			{ pageIndex: 3, rects: [[1, 2, 3, 4]], nextPageRects: [[9, 10, 11, 12], [13, 14, 15, 16]], nextPageIndex: 6 },
			{ pageIndex: 3, rects: [[1, 2, 3, 4]], nextPageRects: [[13, 14, 15, 16]], nextPageIndex: 6 },
			{ pageIndex: 3, rects: [[1, 2, 3, 4]], nextPageRects: [[13, 14, 15, 16]], nextPageIndex: 6 }],
	];

	for (const [format, name, position, compact, expanded = position] of cases) {
		it(`stores ${name}`, () => {
			const mapper = mapperFor(format);
			assert.deepEqual(mapper.compactPosition(position), compact);
			assert.deepEqual(mapper.expandPosition(compact), expanded);
			// The same expansion without a structure
			assert.deepEqual(expandPosition(format, compact), expanded);
		});
	}

	for (const format of ['pdf', 'epub', 'snapshot']) {
		it(`passes null through for ${format}`, () => {
			const mapper = mapperFor(format);
			assert.equal(mapper.compactPosition(null), null);
			assert.equal(mapper.expandPosition(null), null);
		});
	}
});

describe('getTextNodeSpans', () => {
	const structure = {
		metadata: { processor: { type: 'pdf' } },
		content: [
			{ type: 'paragraph', content: [{ text: 'First half' }, { text: ' and second' }] },
			{ type: 'paragraph', content: [{ text: 'Another block' }] },
		],
	};

	it('cuts the first and last node to the position, keeping the ones between', () => {
		const spans = getTextNodeSpans(structure, { start: [0, 0, 6], end: [1, 0, 7] });
		assert.deepEqual(
			spans.map(span => span.node.text.slice(span.start, span.end)),
			['half', ' and second', 'Another']
		);
		assert.deepEqual(spans.map(span => span.ref), [[0, 0], [0, 1], [1, 0]]);
	});
});

describe('position fixtures', () => {
	for (const { format, name, path, data } of fixtures) {
		describe(`${format}/${name}`, () => {
			// The contract a stored position has to keep: every passage has
			// one, and resolving it in the same structure yields the passage's
			// text -- possibly more, since a boundary inside a block with no
			// character geometry (a PDF listing with no textMap) can only
			// resolve to the whole block, but never less.
			it('gives every passage a position that resolves back to its text', () => {
				for (const [i, passage] of getPassages(data).entries()) {
					const where = `passage ${i} (blocks ${passage.startBlock}-${passage.endBlock})`;
					const position = getPassagePosition(data, passage);
					assert.ok(position, `${where} has no position`);
					const found = getPositionText(data, position);
					assert.ok(found, `${where} does not resolve`);
					const got = ignoringSpace(found.text);
					assert.ok(got.includes(ignoringSpace(passage.text)), `${where} resolves to other text`);
					// A position that resolves to the passage's own text
					// reports the passage's block range
					if (got === ignoringSpace(passage.text)) {
						const range = ({ startBlock, endBlock, startOffset, endOffset }) => ({ startBlock, endBlock, startOffset, endOffset });
						assert.deepEqual(range(found), range(passage), `${where} resolves to another range`);
					}
				}
			});

			// A passage's block range, and the range a resolved position
			// reports, read back from the whole structure and from one
			// holding only those blocks give the same text
			it('reads passages and resolved positions back by block range', () => {
				for (const [i, passage] of getPassages(data).entries()) {
					const where = `passage ${i} (blocks ${passage.startBlock}-${passage.endBlock})`;
					const own = getBlockRangeText(data, passage);
					assert.ok(own, `${where} does not read back`);
					assert.equal(ignoringSpace(own.text), ignoringSpace(passage.text), `${where} reads back other text`);
					assert.equal(own.outlinePath, passage.outlinePath);
					assert.equal(own.pageIndex, passage.pageIndex);
					assert.equal(own.pageLabel, passage.pageLabel);
					const partial = partialOf(data, passage.startBlock, passage.endBlock);
					assert.deepEqual(getBlockRangeText(partial, passage), own, `${where} reads back differently in part`);
					const found = getPositionText(data, getPassagePosition(data, passage));
					if (!found) continue;
					const resolved = getBlockRangeText(data, found);
					assert.ok(resolved, `${where}: resolved range does not read back`);
					assert.equal(ignoringSpace(resolved.text), ignoringSpace(found.text), `${where}: resolved range reads back other text`);
				}
			});

			// Every leaf block, and every passage, converted to the source
			// document's own coordinates and back. One whose words come back
			// whole round-trips; the rest are counted by how they fall short,
			// so a change in any of them shows up.
			it('round-trips blocks and passages through source coordinates', () => {
				const mapper = createPositionMapper(data);
				const result = { blocks: tally(), passages: tally() };
				for (const position of blockPositions(data)) {
					result.blocks.total++;
					const words = wordsOf(data, position);
					if (!words) {
						result.blocks.blank++;
						continue;
					}
					const source = mapper.sdtToSourcePosition(position);
					if (!source) {
						result.blocks.noSource++;
						continue;
					}
					score(result.blocks, words, recover(data, mapper, source));
				}
				for (const passage of getPassages(data)) {
					result.passages.total++;
					const position = getPassagePosition(data, passage);
					if (!position) {
						result.passages.noSource++;
						continue;
					}
					score(result.passages, ignoringSpace(passage.text), recoverPassage(data, position));
				}
				const resultJSON = JSON.stringify(result, null, 2);

				if (isUpdateMode()) {
					writeExpected(path, name, 'positions.json', resultJSON);
					return;
				}

				const expected = readExpected(path, name, 'positions.json');
				assert.notEqual(expected, undefined, `Missing expected file: ${name}.positions.json (run npm run test:update)`);
				assert.deepStrictEqual(result, JSON.parse(expected));
			});
		});
	}
});
