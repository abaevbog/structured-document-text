import { it } from 'node:test';
import assert from 'node:assert/strict';
import { getTextChunks } from '../../src/chunker/text.js';
import { getChunks, getPositionsText } from '../../src/chunker/index.js';
import { estimateTokens } from '../../src/chunker/chunks.js';
import { dom } from './helpers.js';

const paragraph = text => ({ type: 'paragraph', content: [{ text }] });
const document = (texts, title = '') => ({
	metadata: { processor: { type: 'snapshot', version: 1 } },
	catalog: { pages: [], outline: title ? [{ title, ref: [0] }] : [] },
	content: [...(title ? [{ ...paragraph(title), type: 'heading' }] : []), ...texts.map(paragraph)]
		.map((block, i) => ({ ...block, anchor: { selectorMap: `#block-${i}` } })),
});

it('preserves the original script estimator on identical nonempty text', () => {
	// Reference values from c73691f's text.length / getCharsPerToken(text).
	// These are compatibility checks, not claims about any model's tokenizer.
	for (let [text, expected] of [
		['The results were measured in 2026.', 11],
		['研究人员测量了结果。', 7.428571428571429],
		['測定結果を比較しました。', 8.857142857142858],
		['측정 결과를 비교했습니다.', 8.857142857142858],
		['قارن الباحثون النتائج.', 8.6],
		['החוקרים השוו תוצאות.', 7.8],
		['Исследователи сравнили результаты.', 11.333333333333334],
		['Οι ερευνητές συνέκριναν αποτελέσματα.', 17.5],
		['शोधकर्ताओं ने परिणामों की तुलना की।', 15.5],
		['นักวิจัยเปรียบเทียบผลลัพธ์', 17.333333333333332],
		['1234567890 3.14%', 15],
		['e\u0301\t x\n\n', 1],
		['𐞀𠀀😀', 3.928571428571429],
	]) assert.ok(Math.abs(estimateTokens(text) - expected) < 1e-10, text);
	assert.equal(estimateTokens(' \n\t '), 0);
});

it('bounds dense passages without losing text when a section has mixed token densities', () => {
	for (let texts of [
		['words '.repeat(600), '研究数据'.repeat(800), '1234567890 '.repeat(300)],
		['word' + ' '.repeat(2000), '😀𐞀𠀀'.repeat(1500)],
	]) {
		let chunks = getTextChunks(document(texts), { overlap: 0 });
		assert.ok(chunks.length > 1);
		for (let chunk of chunks) {
			assert.ok(estimateTokens(chunk.embedText) <= 768 + 1e-7);
			assert.ok(chunk.text.isWellFormed());
		}
		assert.equal(chunks.map(chunk => chunk.text.replace(/\s/gu, '')).join(''), texts.join('').replace(/\s/gu, ''));
	}
});

it('charges numeric outline context at its own density, including in overlapping chunks', () => {
	let title = '1234567890'.repeat(10);
	let chunks = getTextChunks(document(['Ordinary English words. '.repeat(800)], title));
	assert.ok(chunks.length > 1);
	for (let chunk of chunks) {
		assert.equal(chunk.embedText, title + '\n\n' + chunk.text);
		assert.ok(!chunk.text.includes(title));
		assert.ok(estimateTokens(chunk.embedText) <= 768 + 1e-7);
		assert.ok(estimateTokens(chunk.text) <= 668 + 1e-7);
	}
});

it('makes progress when token density leaves less room than the requested overlap', () => {
	let text = ('a '.repeat(500) + '123 '.repeat(25)).trim();
	let structure = dom([text], 'snapshot');
	let chunks = getChunks(structure, { maxTokens: 40, minSize: 0, overlap: 80 });
	let previousEnd = 0;
	for (let chunk of chunks) {
		let { start, end } = chunk.positions[0];
		assert.ok(end > previousEnd);
		assert.ok(!text.slice(previousEnd, start).trim(), 'Do not skip source text');
		assert.ok(estimateTokens(chunk.embedText) <= 40 + 1e-7);
		assert.equal(getPositionsText(structure, chunk.positions), chunk.text);
		previousEnd = end;
	}
	assert.equal(previousEnd, text.length);
});

it('keeps a heading when its own token cost exceeds the context allowance', () => {
	let title = '研究结果'.repeat(90);
	let chunks = getTextChunks(document(['Ordinary English words. '.repeat(800)], title), { overlap: 0 });
	assert.ok(estimateTokens(title) > 768 / 4);
	assert.ok(chunks[0].text.startsWith(title));
	for (let chunk of chunks) {
		assert.equal(chunk.embedText, chunk.text);
		assert.ok(estimateTokens(chunk.embedText) <= 768 + 1e-7);
	}
});

it('keeps explicit character limits independent of estimated token density', () => {
	let chunks = getTextChunks(document(['1'.repeat(3000)]), { maxSize: 1000, minSize: 0, overlap: 0 });
	assert.ok(chunks.some(chunk => estimateTokens(chunk.embedText) > 768));
	assert.ok(chunks.every(chunk => chunk.embedText.length <= 1000));
	assert.equal(chunks.map(chunk => chunk.text).join(''), '1'.repeat(3000));
});

it('applies custom token budgets to mixed scripts without losing text', () => {
	let texts = ['Ordinary words. '.repeat(80), '研究数据'.repeat(160), '12345😀 '.repeat(80)];
	for (let maxTokens of [2, 64, 128, 459, 689, 1536]) {
		let chunks = getTextChunks(document(texts), { maxTokens, overlap: 0 });
		assert.ok(chunks.length);
		if (maxTokens > 768) assert.ok(chunks.some(chunk => estimateTokens(chunk.embedText) > 768));
		for (let chunk of chunks) {
			assert.ok(estimateTokens(chunk.embedText) <= maxTokens + 1e-7);
			assert.ok(chunk.text.isWellFormed());
		}
		assert.equal(chunks.map(chunk => chunk.text.replace(/\s/gu, '')).join(''), texts.join('').replace(/\s/gu, ''));
	}
});

it('reserves custom token budgets for context and default overlap', () => {
	let title = '1234567890'.repeat(10);
	let structure = document(['Ordinary English words. '.repeat(500)], title);
	for (let maxTokens of [2, 64, 459, 689]) {
		let chunks = getTextChunks(structure, { maxTokens });
		assert.ok(chunks.length > 1);
		for (let chunk of chunks) {
			assert.ok(estimateTokens(chunk.embedText) <= maxTokens + 1e-7);
			if (maxTokens >= 459) assert.equal(chunk.embedText, title + '\n\n' + chunk.text);
		}
	}
});

it('keeps sentence boundaries and heading context with small token budgets', () => {
	let text = 'Researchers measured the effects of temperature on seed germination. '
		+ 'The results indicate that warmer conditions accelerated growth. '
		+ 'These observations help researchers choose a suitable planting date. ';
	let structure = document([text.repeat(10)], 'Methods');
	for (let maxTokens of [64, 119, 128]) {
		let chunks = getTextChunks(structure, { maxTokens });
		assert.ok(chunks.length > 1);
		for (let chunk of chunks) {
			assert.ok(chunk.text.endsWith('.'), 'Short sentences should not be split midword');
			assert.equal(chunk.embedText, 'Methods\n\n' + chunk.text);
			assert.ok(estimateTokens(chunk.embedText) <= maxTokens + 1e-7);
		}
	}
});

it('leaves room for supplementary characters when a tiny budget could include context', () => {
	let chunks = getTextChunks(document(['words 😀 '.repeat(20)], 'A'), { maxTokens: 2, minSize: 0, overlap: 0 });
	assert.equal(chunks.map(chunk => chunk.text.replace(/\s/gu, '')).join(''), 'A' + 'words😀'.repeat(20));
	assert.ok(chunks.every(chunk => estimateTokens(chunk.embedText) <= 2 + 1e-7));
});

it('preserves source positions and default output with explicit token budgets', () => {
	let texts = ['First paragraph. '.repeat(120), '研究结果'.repeat(250)];
	for (let type of ['epub', 'snapshot']) {
		let structure = dom(texts, type);
		assert.deepEqual(getChunks(structure, { maxTokens: 768 }), getChunks(structure));
		let chunks = getChunks(structure, { maxTokens: 459 });
		assert.deepEqual(chunks.map(({ positions, ...chunk }) => chunk), getTextChunks(structure, { maxTokens: 459 }));
		for (let chunk of chunks) {
			assert.ok(estimateTokens(chunk.embedText) <= 459 + 1e-7);
			assert.equal(getPositionsText(structure, JSON.parse(JSON.stringify(chunk.positions))), chunk.text);
		}
	}
});

it('rejects invalid token budgets and combining token and character ceilings', () => {
	for (let get of [getChunks, getTextChunks]) {
		for (let texts of [[], ['Body']]) {
			let structure = document(texts);
			for (let maxTokens of [null, 0, 1, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '459']) {
				assert.throws(() => get(structure, { maxTokens }), TypeError);
			}
			assert.throws(() => get(structure, { maxTokens: 459, maxSize: 1000 }), TypeError);
		}
	}
});
