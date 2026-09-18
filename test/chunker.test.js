import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	BUDGET_TOKENS,
	MIN_TOKENS,
	OVERLAP_TOKENS,
	getCharacterMetrics,
	estimateTokens,
	splitSentences,
	getStructureSections,
	getPassages,
	getPassagePosition,
	getTextPassages,
	getPassageDigest,
	getNextPassage,
} from '../src/chunker.js';
import { discoverFixtures, isUpdateMode, readExpected, writeExpected } from './helpers.js';

const fixtures = discoverFixtures();

// Pure Latin letters estimate at exactly four characters per token
const LATIN = 4;
const BUDGET_CHARS = BUDGET_TOKENS * LATIN;
const MIN_CHARS = MIN_TOKENS * LATIN;

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const texts = chunks => chunks.map(chunk => chunk.text);
const letters = chars => 'a'.repeat(chars);
// Numbering in letters: digits cost a token each and would skew the scale
const label = i => i.toString(26).split('').map(d => 'abcdefghijklmnopqrstuvwxyz'[parseInt(d, 26)]).join('');
const word = (tag, i) => tag + label(i);
const words = (tag, n) => Array.from({ length: n }, (x, i) => word(tag, i)).join(' ');
// A paragraph of `count` sentences of about 50 characters, so about 12
// estimated tokens each. Sentences start with a capital: segmentation
// doesn't break on a period followed by lowercase.
const sentences = (tag, count) => Array.from({ length: count },
	(x, i) => `${tag} sentence number ${label(i)} with several words in it.`).join(' ');
// `blockCount` block texts of `per` words each, numbered straight through
// so `${tag}a` is in the first block
const wordBlocks = (tag, blockCount, per) => Array.from({ length: blockCount },
	(x, i) => Array.from({ length: per }, (y, j) => word(tag, i * per + j)).join(' '));

// A PDF structure from section specs [{ path, blocks }], where a block is
// its text or { text, position }. A section with a path gets a heading
// block first. Returns the structure and each section's [first, last] body
// block indexes.
function structureOf(specs) {
	const content = [];
	const outline = [];
	const at = [];
	const paragraph = (text, position) => ({
		type: 'paragraph',
		content: [{ text }],
		anchor: position
			? { pageRects: position.rects.map(rect => [position.pageIndex, ...rect]) }
			: {},
	});
	for (const spec of specs) {
		if (spec.path) {
			const parts = spec.path.split(' > ');
			let items = outline;
			for (let i = 0; i < parts.length; i++) {
				const item = { title: parts[i], children: [] };
				if (i === parts.length - 1) item.ref = [content.length];
				items.push(item);
				items = item.children;
			}
			content.push({ type: 'heading', content: [{ text: parts[parts.length - 1] }], anchor: {} });
		}
		const first = content.length;
		for (const block of spec.blocks) {
			content.push(typeof block === 'string'
				? paragraph(block)
				: paragraph(block.text, block.position));
		}
		at.push([first, content.length - 1]);
	}
	const structure = {
		schemaVersion: '1.1.0',
		metadata: {
			processor: { type: 'pdf', version: 3 },
			dateCreated: '2026-01-01T00:00:00Z',
			source: { contentType: 'application/pdf', hash: '0'.repeat(32) },
		},
		catalog: { pages: [], outline },
		content,
	};
	return { structure, at };
}

describe('geometry', () => {
	it('scales a token\'s worth by the script of the text', () => {
		const scale = text => getCharacterMetrics(text).budget / BUDGET_TOKENS;
		closeTo(scale('climatechange'), 4);
		closeTo(scale('気候変動'.repeat(10)), 1.4);
		closeTo(scale('изменениеклимата'), 3);
		const mixed = scale('climatechange気候変動気候変動');
		assert.ok(mixed > 1.4 && mixed < 4);
	});

	it('counts whitespace as free', () => {
		const scale = text => getCharacterMetrics(text).budget / BUDGET_TOKENS;
		assert.ok(scale('climate change') > scale('climatechange'));
		assert.equal(estimateTokens('climate change'), estimateTokens('climatechange'));
	});

	it('charges digits and punctuation a token each', () => {
		const scale = text => getCharacterMetrics(text).budget / BUDGET_TOKENS;
		closeTo(scale('2024'), 1);
		closeTo(scale('...!!!'), 1);
		assert.ok(scale('page 12, line 3.') < scale('page twelve line three'));
	});

	it('mirrors the exported geometry in the character metrics', () => {
		for (const text of ['climate change', '気候変動'.repeat(10)]) {
			const metrics = getCharacterMetrics(text);
			const scale = metrics.budget / BUDGET_TOKENS;
			assert.ok(scale > 0);
			closeTo(metrics.minSize, MIN_TOKENS * scale);
			closeTo(metrics.overlap, OVERLAP_TOKENS * scale);
		}
	});

	it('estimates tokens by the same measure', () => {
		assert.equal(estimateTokens(letters(400)), 100);
		assert.equal(estimateTokens(''), 0);
	});
});

describe('splitSentences', () => {
	it('locates each sentence in the text whatever its size', () => {
		const text = 'First sentence here. Second one follows.  Third ends it.';
		const units = splitSentences(text);
		assert.deepEqual(texts(units), ['First sentence here.', 'Second one follows.', 'Third ends it.']);
		for (const unit of units) {
			assert.equal(text.slice(unit.start, unit.end), unit.text);
		}
	});

	it('splits scripts without Western punctuation at real boundaries', () => {
		assert.equal(splitSentences('東京に行きました。それから寝ました。').length, 2);
	});
});

describe('getTextPassages', () => {
	it('ignores blank input', () => {
		assert.deepEqual(getTextPassages(''), []);
		assert.deepEqual(getTextPassages('  \n '), []);
	});

	it('uses the text\'s own geometry when none is given', () => {
		const text = ('word '.repeat(60) + '\n').repeat(40);
		assert.deepEqual(getTextPassages(text), getTextPassages(text, getCharacterMetrics(text)));
	});

	it('returns text within the budget as a single passage', () => {
		assert.deepEqual(texts(getTextPassages('A short title')), ['A short title']);
		assert.equal(getTextPassages(letters(BUDGET_CHARS)).length, 1);
		assert.ok(getTextPassages(letters(BUDGET_CHARS + 1)).length > 1);
	});

	it('cuts a long text into passages that are slices of it, in order', () => {
		const text = ('word '.repeat(60) + '\n').repeat(40);
		const chunks = getTextPassages(text);
		assert.ok(chunks.length > 1);
		for (const piece of chunks) {
			assert.equal(text.slice(piece.start, piece.end), piece.text);
			assert.ok(piece.size > 0);
		}
		for (let i = 1; i < chunks.length; i++) {
			assert.ok(chunks[i].start >= chunks[i - 1].start);
		}
	});

	it('keeps every passage within the budget', () => {
		const text = [words('alpha', 700), words('bravo', 700), words('charlie', 700)].join('\n\n');
		const chunks = getTextPassages(text);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(chunk.size <= getCharacterMetrics(text).budget);
		}
	});

	it('doesn\'t put two substantial paragraphs in one passage', () => {
		// Each well under the budget, together over it
		const a = words('alpha', 250);
		const b = words('bravo', 250);
		const chunks = texts(getTextPassages(`${a}\n\n${b}`));
		assert.equal(chunks.length, 2);
		assert.ok(chunks[0].includes(word('alpha', 0)) && chunks[0].includes(word('alpha', 249)));
		assert.ok(!chunks[0].includes('bravo'));
		assert.ok(chunks[1].includes(word('bravo', 0)) && !chunks[1].includes('alpha'));
	});

	it('divides oversized text into even pieces at paragraph boundaries', () => {
		// Four paragraphs of about 250 tokens: over the budget, but only
		// just, so the even division is two pieces of two paragraphs
		const chunks = getTextPassages(
			['Alpha', 'Bravo', 'Charlie', 'Delta'].map(tag => sentences(tag, 20)).join('\n\n'));
		assert.equal(chunks.length, 2);
		assert.ok(chunks[0].text.includes('Alpha sentence') && chunks[0].text.includes('Bravo sentence'));
		assert.ok(!chunks[0].text.includes('Charlie'));
		assert.ok(chunks[1].text.includes('Charlie sentence') && chunks[1].text.includes('Delta sentence'));
		assert.ok(Math.abs(chunks[0].size - chunks[1].size) < chunks[0].size * 0.2);
	});

	it('absorbs a tail too small to stand alone rather than leaving it a passage', () => {
		// A paragraph filling most of the budget and a short one after it
		const text = sentences('Alpha', 65) + '\n\n' + sentences('Bravo', 8);
		const { budget, minSize } = getCharacterMetrics(text);
		const chunks = getTextPassages(text);
		assert.equal(chunks.length, 2);
		for (const chunk of chunks) {
			assert.ok(chunk.size >= minSize);
			assert.ok(chunk.size <= budget);
		}
		assert.ok(Math.abs(chunks[0].size - chunks[1].size) < chunks[0].size * 0.35);
	});

	it('combines paragraphs too small to embed on their own', () => {
		// A heading and a date, then two substantial paragraphs
		const chunks = texts(getTextPassages(
			`Annotations\n(11/12/2024)\n${words('alpha', 250)}\n\n${words('bravo', 250)}`));
		assert.equal(chunks.length, 2);
		assert.ok(chunks[0].includes('Annotations') && chunks[0].includes('11/12/2024'));
		assert.ok(chunks[0].includes(word('alpha', 0)));
		assert.ok(!chunks[1].includes('Annotations'));
		assert.ok(chunks[1].includes(word('bravo', 0)) && !chunks[1].includes('alpha'));
	});

	it('splits an oversized paragraph into even pieces at sentence boundaries', () => {
		// About 1300 estimated tokens with no paragraph breaks to split at
		const list = Array.from({ length: 100 },
			(x, i) => `Sentence ${label(i)} has some words about subject number ${label(i)}.`);
		const { budget } = getCharacterMetrics(list.join(' '));
		const chunks = getTextPassages(list.join(' '));
		assert.equal(chunks.length, 2);
		for (const chunk of chunks) {
			assert.ok(chunk.size <= budget);
			// Even pieces, not full-then-short
			assert.ok(chunk.size > budget * 0.5);
		}
		const joined = texts(chunks).join('\n');
		for (const sentence of list) {
			assert.ok(joined.includes(sentence));
		}
		// Adjacent pieces of one paragraph overlap
		assert.ok(list.some(sentence => chunks[0].text.includes(sentence)
			&& chunks[1].text.includes(sentence)));
	});

	it('overlaps pieces even when no whole sentence fits the allowance', () => {
		// Every sentence is far longer than the overlap, so the tail of one
		// is trimmed rather than dropped
		const text = Array.from({ length: 30 },
			(x, i) => `Sentence ${label(i)} ${words('word', 70)}.`).join(' ');
		const { budget, overlap } = getCharacterMetrics(text);
		const chunks = getTextPassages(text);
		assert.ok(chunks.length > 2);
		for (let i = 1; i < chunks.length; i++) {
			const shared = chunks[i - 1].end - chunks[i].start;
			assert.ok(shared > 0, `pieces ${i - 1} and ${i} share nothing`);
			assert.ok(shared <= overlap);
			// The carried tail opens on a whole word
			assert.ok(/^\S/u.test(chunks[i].text) && text[chunks[i].start - 1] === ' ');
		}
		for (const chunk of chunks) {
			assert.ok(chunk.size <= budget);
		}
	});

	it('doesn\'t leave an undersized piece at the end of a split', () => {
		for (const count of [70, 100, 130, 160, 220]) {
			const list = Array.from({ length: count },
				(x, i) => `Sentence ${label(i)} has a few more words in it about subject ${label(i)}.`);
			const { minSize } = getCharacterMetrics(list.join(' '));
			const chunks = getTextPassages(list.join(' '));
			for (const chunk of chunks) {
				assert.ok(chunk.size >= minSize, `${count} sentences: piece of ${chunk.size} chars`);
			}
		}
	});

	it('divides a text with no boundaries at all', () => {
		const chunks = getTextPassages('x'.repeat(20000));
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			assert.ok(chunk.size <= BUDGET_CHARS);
		}
	});

	it('budgets CJK text more tightly than alphabetic text', () => {
		const cjk = getTextPassages('気候変動。'.repeat(2000));
		const latin = getTextPassages('climate change. '.repeat(625));
		assert.ok(cjk.length > latin.length);
	});

	it('scales to the whole text, not its opening', () => {
		// A Latin head on a CJK body: the body sets the budget
		const chunks = getTextPassages('climate change. '.repeat(20) + '\n\n' + '気候変動。'.repeat(1200));
		assert.ok(chunks.length > 5);
		for (const chunk of chunks) {
			assert.ok(chunk.size < BUDGET_CHARS / 2);
		}
	});

	it('sizes to a geometry it is handed', () => {
		const text = 'word '.repeat(400);
		const tiny = { budget: 100, minSize: 20, overlap: 5 };
		assert.ok(getTextPassages(text, tiny).length > getTextPassages(text).length);
		for (const chunk of getTextPassages(text, tiny)) {
			assert.ok(chunk.size <= 100);
		}
	});
});

describe('getPassages', () => {
	it('doesn\'t put two substantial sections in one passage', () => {
		const { structure, at } = structureOf([
			{ path: 'Introduction', blocks: wordBlocks('alpha', 5, 50) },
			{ path: 'Methods', blocks: wordBlocks('bravo', 5, 50) },
		]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 2);
		assert.ok(passages[0].text.includes(word('alpha', 0)) && !passages[0].text.includes('bravo'));
		assert.deepEqual([passages[0].startBlock, passages[0].endBlock], at[0]);
		assert.equal(passages[0].startOffset, 0);
		assert.equal(passages[0].endOffset, wordBlocks('alpha', 5, 50)[4].length);
		assert.ok(passages[1].text.includes(word('bravo', 0)) && !passages[1].text.includes(word('alpha', 0)));
		assert.deepEqual([passages[1].startBlock, passages[1].endBlock], at[1]);
	});

	it('prefixes the embedded text with the section\'s outline path', () => {
		const { structure } = structureOf([
			{ path: 'Results > Field studies', blocks: [words('alpha', 250)] },
		]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 1);
		assert.ok(passages[0].embedText.startsWith('Results > Field studies\n\n'));
		assert.ok(passages[0].text.startsWith(word('alpha', 0)));
		assert.equal(passages[0].outlinePath, 'Results > Field studies');
	});

	it('carries each merged section\'s own heading into the embedded text', () => {
		// A stub too small to stand alone merges into the section after it
		const { structure } = structureOf([
			{ path: 'Funding', blocks: [words('alpha', 12)] },
			{ path: 'Methods', blocks: wordBlocks('bravo', 4, 50) },
		]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 1);
		const embedded = passages[0].embedText;
		assert.ok(embedded.indexOf('Funding') < embedded.indexOf(word('alpha', 0)));
		assert.ok(embedded.indexOf(word('alpha', 0)) < embedded.indexOf('Methods'));
		assert.ok(embedded.indexOf('Methods') < embedded.indexOf(word('bravo', 0)));
		// The plain text stays free of them, since block offsets index it
		assert.ok(!passages[0].text.includes('Funding') && !passages[0].text.includes('Methods'));
		// Both headings are counted against the budget
		assert.ok(passages[0].size > passages[0].text.length);
	});

	it('labels a passage with the section it starts in', () => {
		// Two small sections merge, then a large one splits: the pieces after
		// the first belong to the section they sit in
		const { structure } = structureOf([
			{ path: 'Preface', blocks: [words('alpha', 12)] },
			{ path: 'Discussion', blocks: wordBlocks('bravo', 8, 100) },
		]);
		const passages = getPassages(structure);
		assert.ok(passages.length > 1);
		assert.equal(passages[0].outlinePath, 'Preface');
		for (const passage of passages.slice(1)) {
			assert.equal(passage.outlinePath, 'Discussion');
			assert.ok(!passage.embedText.includes('Preface'));
		}
	});

	it('combines sections too small to embed on their own', () => {
		// Front matter before the first heading rides along with the section
		// that follows it
		const { structure, at } = structureOf([
			{ path: '', blocks: ['Title page', 'Copyright notice'] },
			{ path: 'Introduction', blocks: wordBlocks('alpha', 8, 30) },
			{ path: 'Methods', blocks: wordBlocks('bravo', 10, 25) },
		]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 2);
		assert.ok(passages[0].text.includes('Title page') && passages[0].text.includes('Copyright notice'));
		assert.ok(passages[0].text.includes(word('alpha', 0)));
		assert.equal(passages[0].startBlock, at[0][0]);
		assert.equal(passages[0].endBlock, at[1][1]);
		assert.ok(passages[1].text.includes(word('bravo', 0)) && !passages[1].text.includes(word('alpha', 0)));
	});

	it('joins a trailing small section to the previous passage', () => {
		const { structure, at } = structureOf([
			{ path: 'Body', blocks: wordBlocks('alpha', 10, 25) },
			{ path: 'Appendix', blocks: ['Short appendix note.', 'A closing line.'] },
		]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 1);
		assert.ok(passages[0].text.includes('Short appendix note'));
		assert.equal(passages[0].startBlock, at[0][0]);
		assert.equal(passages[0].endBlock, at[1][1]);
	});

	it('sizes each section at its own scale', () => {
		// An English abstract in a Chinese paper: the abstract fits its own
		// budget in one passage, and the Chinese body splits at its tighter one
		const { structure } = structureOf([
			{ path: 'Abstract', blocks: [words('alpha', 350)] },
			{ path: '方法', blocks: ['気候変動。'.repeat(400)] },
		]);
		const passages = getPassages(structure);
		const abstract = passages.filter(passage => passage.outlinePath === 'Abstract');
		const body = passages.filter(passage => passage.outlinePath === '方法');
		assert.equal(abstract.length, 1);
		assert.ok(abstract[0].size > BUDGET_CHARS / 2);
		assert.ok(body.length >= 2);
		for (const passage of body) {
			assert.ok(passage.size < BUDGET_CHARS / 2);
		}
	});

	it('groups small sections by their tokens, not their characters', () => {
		// 300 CJK characters are over the minimum in tokens, so the section
		// stands alone rather than riding along with the English one
		const { structure } = structureOf([
			{ path: '摘要', blocks: ['気候変動。'.repeat(60)] },
			{ path: 'Introduction', blocks: [words('bravo', 300)] },
		]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 2);
		assert.ok(!passages[0].text.includes('bravo'));
	});

	it('splits an oversized block into numbered pieces at their own offsets', () => {
		const list = Array.from({ length: 100 },
			(x, i) => `Sentence ${label(i)} has some words about subject number ${label(i)}.`);
		const block = list.join(' ');
		const position = { pageIndex: 4, rects: [[10, 20, 300, 40]] };
		const { structure, at } = structureOf([
			{ path: 'Discussion', blocks: [{ text: block, position }] },
		]);
		const passages = getPassages(structure);
		assert.ok(passages.length > 1);
		for (let i = 0; i < passages.length; i++) {
			const passage = passages[i];
			assert.ok(passage.embedText.startsWith('Discussion\n\n'));
			assert.equal(passage.outlinePath, 'Discussion');
			assert.equal(passage.startBlock, at[0][0]);
			assert.equal(passage.endBlock, at[0][0]);
			// A PDF without labels is labelled by ordinal
			assert.equal(passage.pageLabel, '5');
			assert.deepEqual(getPassagePosition(structure, passage), position);
			assert.equal(passage.sectionPart, i + 1);
			assert.equal(passage.sectionParts, passages.length);
			assert.equal(passage.text, block.slice(passage.startOffset, passage.endOffset));
			if (i) assert.ok(passage.startOffset > passages[i - 1].startOffset);
		}
		const joined = texts(passages).join('\n');
		for (const sentence of list) {
			assert.ok(joined.includes(sentence));
		}
	});

	it('points each piece of a split section at the blocks it covers', () => {
		const blocks = Array.from({ length: 100 }, (x, i) => ({
			text: `Sentence ${label(i)} has some words about subject number ${label(i)}.`,
			position: { pageIndex: i, rects: [[10, 20, 300, 40]] },
		}));
		const { structure, at } = structureOf([{ path: 'Discussion', blocks }]);
		const passages = getPassages(structure);
		assert.ok(passages.length > 1);
		for (let i = 0; i < passages.length; i++) {
			const passage = passages[i];
			assert.ok(passage.endBlock >= passage.startBlock);
			if (i) assert.ok(passage.startBlock > passages[i - 1].startBlock);
			// Labelled by its own first block, and positioned from there to
			// its last: a block per page here, so the position ends on the
			// last block's page
			const pageIndex = passage.startBlock - at[0][0];
			const endPageIndex = passage.endBlock - at[0][0];
			assert.equal(passage.pageLabel, String(pageIndex + 1));
			const position = getPassagePosition(structure, passage);
			assert.equal(position.pageIndex, pageIndex);
			assert.deepEqual(position.rects, [[10, 20, 300, 40]]);
			assert.deepEqual(position.nextPageRects, [[10, 20, 300, 40]]);
			assert.equal(position.nextPageIndex, endPageIndex > pageIndex + 1 ? endPageIndex : undefined);
		}
		assert.ok(passages[passages.length - 1].startBlock > at[0][0]);
	});

	it('marks an unsplit section as its only piece', () => {
		const { structure } = structureOf([{ path: 'Body', blocks: [words('alpha', 250)] }]);
		const passages = getPassages(structure);
		assert.equal(passages.length, 1);
		assert.equal(passages[0].sectionPart, 1);
		assert.equal(passages[0].sectionParts, 1);
		assert.equal(passages[0].pageLabel, null);
		assert.equal(getPassagePosition(structure, passages[0]), null);
	});

	it('estimates each passage in tokens at its scale, beside its size in characters', () => {
		// One section, so its scale is the whole text's
		const text = words('alpha', 250);
		const scale = getCharacterMetrics(text).budget / BUDGET_TOKENS;
		const { structure } = structureOf([{ path: 'Body', blocks: [text] }]);
		const [passage] = getPassages(structure);
		assert.equal(passage.size, passage.embedText.length);
		assert.equal(passage.tokens, Math.round(passage.size / scale));
		const [piece] = getTextPassages(text);
		assert.equal(piece.tokens, Math.round(piece.size / scale));
	});

	it('returns nothing when there is no indexable text', () => {
		assert.deepEqual(getPassages({ content: [] }), []);
	});
});

// A small hand-built structure: an outline heading at block 1, an excluded
// running head, a reference entry, an auxiliary caption, PDF page geometry
const structure = {
	schemaVersion: '1.1.0',
	metadata: { processor: { type: 'pdf', version: 3 }, dateCreated: '2026-01-01T00:00:00Z', source: { contentType: 'application/pdf', hash: '0'.repeat(32) } },
	catalog: {
		pages: [
			{ label: 'i', contentRange: [[0], [2]] },
			{ label: '2', contentRange: [[3], [5]] },
		],
		outline: [
			{ title: 'Introduction', ref: [1], children: [{ title: 'Background', ref: [3] }] },
		],
	},
	content: [
		{ type: 'paragraph', content: [{ text: 'Front matter paragraph.' }], anchor: { pageRects: [[0, 1, 2, 3, 4]] } },
		{ type: 'heading', content: [{ text: 'Introduction' }], anchor: { pageRects: [[0, 1, 2, 3, 4]] } },
		{ type: 'paragraph', content: [{ text: 'Running head' }], anchor: {}, flowClass: 'excluded' },
		{ type: 'heading', content: [{ text: 'Background' }], anchor: { pageRects: [[1, 1, 2, 3, 4]] } },
		{ type: 'paragraph', content: [{ text: 'Body text of the background section.' }], anchor: { pageRects: [[1, 5, 6, 7, 8], [1, 9, 10, 11, 12]] } },
		{ type: 'paragraph', content: [{ text: 'Figure 1: A caption.' }], anchor: { pageRects: [[1, 1, 2, 3, 4]] }, flowClass: 'auxiliary' },
		{ type: 'paragraph', content: [{ text: 'Smith, J. (2020). A reference.' }], anchor: { pageRects: [[1, 1, 2, 3, 4]] }, reference: true },
	],
};

describe('getStructureSections', () => {
	it('walks the outline, skipping heading blocks and excluded flow', () => {
		const sections = getStructureSections(structure);
		// The Introduction section has only its heading and a running head,
		// so it has no text of its own and isn't reported
		assert.deepEqual(sections.map(s => [s.outlinePath, s.startBlock, s.endBlock]), [
			['', 0, 0],
			['Introduction > Background', 3, 6],
		]);
		const background = sections[1];
		assert.deepEqual(background.blocks.map(b => b.index), [4, 5, 6]);
		assert.equal(background.blocks[1].flowClass, 'auxiliary');
		assert.equal(background.blocks[2].reference, true);
		assert.equal(background.text, background.blocks.map(b => b.text).join('\n'));
	});

	it('locates blocks by page geometry and labels', () => {
		const sections = getStructureSections(structure);
		const body = sections[1].blocks[0];
		assert.equal(body.pageIndex, 1);
		assert.equal(body.pageLabel, '2');
		assert.deepEqual(body.position, { pageIndex: 1, rects: [[5, 6, 7, 8], [9, 10, 11, 12]] });
		// A section is located at its heading
		assert.deepEqual(sections[1].position, { pageIndex: 1, rects: [[1, 2, 3, 4]] });
		assert.equal(sections[0].pageLabel, 'i');
	});

	it('drops reference and auxiliary blocks when asked for indexable sections', () => {
		const sections = getStructureSections(structure, { onlyIndexable: true });
		const background = sections.find(s => s.outlinePath === 'Introduction > Background');
		assert.deepEqual(background.blocks.map(b => b.index), [4]);
		assert.equal(background.text, 'Body text of the background section.');
		// A section then starts at its first remaining block
		assert.equal(background.startBlock, 4);
	});

	it('treats a document without an outline as one section', () => {
		const noOutline = { ...structure, catalog: { ...structure.catalog, outline: [] } };
		const sections = getStructureSections(noOutline);
		assert.deepEqual(sections.map(s => [s.startBlock, s.endBlock]), [[0, 6]]);
		assert.equal(sections[0].outlinePath, '');
		// Heading blocks are ordinary text when nothing marks them as headings
		assert.deepEqual(sections[0].blocks.map(b => b.index), [0, 1, 3, 4, 5, 6]);
	});

	it('returns nothing for an empty document', () => {
		assert.deepEqual(getStructureSections({ content: [] }), []);
		assert.deepEqual(getStructureSections(null), []);
	});
});

describe('getPassages on a mixed structure', () => {
	it('leaves out excluded, reference and auxiliary blocks', () => {
		const passages = getPassages(structure);
		const joined = texts(passages).join('\n');
		assert.ok(joined.includes('Body text of the background section.'));
		assert.ok(!joined.includes('Running head'));
		assert.ok(!joined.includes('Smith, J.'));
		assert.ok(!joined.includes('Figure 1'));
		// The front matter is too small to stand alone, so it merges with
		// the background section; the merged passage ends at the body block,
		// before the caption and the reference entry
		assert.equal(passages.length, 1);
		assert.equal(passages[0].startBlock, 0);
		assert.equal(passages[0].endBlock, 4);
		assert.equal(passages[0].outlinePath, 'Introduction > Background');
	});
});

describe('getPassageDigest', () => {
	it('fingerprints the words of the passages, not their whitespace', () => {
		const a = getPassageDigest([{ text: 'one two' }, { text: 'three' }]);
		assert.match(a, /^[0-9a-f]{16}$/);
		assert.equal(getPassageDigest([{ text: ' one\n\ttwo ' }, { text: 'three' }]), a);
		assert.notEqual(getPassageDigest([{ text: 'one two three' }]), a);
		assert.notEqual(getPassageDigest([{ text: 'one two' }, { text: 'four' }]), a);
	});
});

describe('getNextPassage', () => {
	it('walks passages by block', () => {
		const passages = getPassages(structure);
		const walked = [];
		let block = 0;
		while (true) {
			const passage = getNextPassage(structure, block);
			if (!passage) break;
			walked.push(passage);
			block = passage.endBlock + 1;
		}
		assert.deepEqual(walked, passages);
		assert.equal(getNextPassage(null, 0), null);
	});
});

describe('fixtures', () => {
	for (const { format, name, path, data } of fixtures) {
		describe(`${format}/${name}`, () => {
			it('produces expected passages', () => {
				const passages = getPassages(data);
				const result = { digest: getPassageDigest(passages), passages };
				const resultJSON = JSON.stringify(result, null, 2);

				if (isUpdateMode()) {
					writeExpected(path, name, 'passages.json', resultJSON);
					return;
				}

				const expected = readExpected(path, name, 'passages.json');
				assert.notEqual(expected, undefined, `Missing expected file: ${name}.passages.json (run npm run test:update)`);
				assert.deepStrictEqual(result, JSON.parse(expected));
			});

			it('re-derives each passage from the blocks it references', () => {
				// The indexable blocks by index, the way a consumer holding a
				// block range would rebuild a passage's text
				const byIndex = new Map();
				for (const section of getStructureSections(data, { onlyIndexable: true })) {
					for (const block of section.blocks) byIndex.set(block.index, block.text);
				}
				for (const passage of getPassages(data)) {
					const blocks = [];
					for (let i = passage.startBlock; i <= passage.endBlock; i++) {
						if (byIndex.has(i)) blocks.push(byIndex.get(i));
					}
					const joined = blocks.join('\n');
					const end = joined.length - blocks[blocks.length - 1].length + passage.endOffset;
					// Sections joined into one passage carry a double newline
					// the block join doesn't, so only the words are compared
					const collapse = text => text.replace(/\s+/g, ' ').trim();
					assert.equal(collapse(joined.slice(passage.startOffset, end)), collapse(passage.text));
				}
			});
		});
	}
});
