import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChunks, getAnchorContent, getChunkOutline } from '../../src/chunker/index.js';
import { getPlainTextChunks, getTextChunks } from '../../src/chunker/text.js';
import { noOverlap, paragraph, textDocument, dom, restore } from './helpers.js';

const entry = (title, chunks, children = []) => ({ title, chunks, children });
// Chunks with only what the outline is made from: where each one's sections start
const chunk = (...paths) => ({ sections: paths.map((outlinePath, i) => ({ outlinePath, start: i })) });

describe('the outline of chunks', () => {
	it('gives each section the chunks with its text and its subsections\'', () => {
		let structure = textDocument([
			paragraph('Front matter.'), paragraph('Method text.'), paragraph('Stimuli text.'), paragraph('Results text.'),
		], { outline: [
			{ title: 'Method', ref: [1], children: [{ title: 'Stimuli', ref: [2] }] },
			{ title: 'Results', ref: [3] },
		] });
		let chunks = getTextChunks(structure, noOverlap);
		assert.deepEqual(chunks.map(({ sections }) => sections[0].outlinePath), [[], ['Method'], ['Method', 'Stimuli'], ['Results']]);
		assert.deepEqual(getChunkOutline(chunks), [
			// The text before the first outline entry
			entry(null, [[0, 0]]),
			entry('Method', [[1, 2]], [entry('Stimuli', [[2, 2]])]),
			entry('Results', [[3, 3]]),
		]);
	});

	it('gives a chunk that crosses sections to each of them', () => {
		assert.deepEqual(getChunkOutline([
			chunk([], ['Intro']),
			chunk(['Intro'], ['Intro', 'Aims'], ['Methods']),
			chunk(['Methods']),
		]), [
			entry(null, [[0, 0]]),
			entry('Intro', [[0, 1]], [entry('Aims', [[1, 1]])]),
			entry('Methods', [[1, 2]]),
		]);
	});

	it('gives a section the text comes back to, or sections with the same path, each run of chunks', () => {
		// Two experiments, each with its Method and Results
		let chunks = [['Method'], ['Method', 'Stimuli'], ['Method'], ['Results'], ['Method'], ['Method', 'Stimuli'], ['Results']]
			.map(path => chunk(path));
		assert.deepEqual(getChunkOutline(chunks), [
			// Once, where the text first comes to it, without the chunks of Results between
			entry('Method', [[0, 2], [4, 5]], [entry('Stimuli', [[1, 1], [5, 5]])]),
			entry('Results', [[3, 3], [6, 6]]),
		]);
	});

	it('gives text under no heading one entry without a title', () => {
		assert.deepEqual(getChunkOutline([chunk([]), chunk(['Intro']), chunk([])]),
			[entry(null, [[0, 0], [2, 2]]), entry('Intro', [[1, 1]])]);
		assert.deepEqual(getChunkOutline(getPlainTextChunks('One.\n\nTwo.')), [entry(null, [[0, 0]])]);
		assert.deepEqual(getChunkOutline([]), []);
	});

	it('takes chunks recovered from their anchors', () => {
		let structure = dom(['First text.', 'Second text.', 'Third text.'], 'snapshot');
		structure.catalog.outline = [{ title: 'One', ref: [0] }, { title: 'Two', ref: [1] }];
		let chunks = getChunks(structure, noOverlap);
		let recovered = chunks.map(({ anchor }) => getAnchorContent(structure, restore(anchor)));
		assert.deepEqual(getChunkOutline(recovered), getChunkOutline(chunks));
		assert.deepEqual(getChunkOutline(recovered).map(({ title }) => title), ['One', 'Two']);
	});
});
