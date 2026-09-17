import { getNestedBlockPlainText } from './text.js';

// Passage geometry in estimated tokens: the most a passage holds, the least
// worth standing alone, and how much of a split passage's tail is carried
// into the next. The budget is a ceiling on estimated tokens for splitting,
// not a fill target; real token counts run past it when the estimate
// undercounts.
export const BUDGET_TOKENS = 768;
export const MIN_TOKENS = 120;
export const OVERLAP_TOKENS = 48;

// The two newlines between joined paragraphs
const JOIN_SIZE = 2;

let sentenceSegmenter = null;
const passageCache = new WeakMap();


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The passages a document divides into for embedding: its sections, less
 * reference entries and auxiliary blocks, split to the budget. Deterministic
 * for a given structure.
 *
 * Reference entries are keyword-dense but say nothing, and would crowd out
 * real matches. Auxiliary blocks mix captions with equations, axis labels
 * and index entries.
 *
 * @param {Object} structure - A materialized structure
 * @returns {Array<{ text, embedText, size, outlinePath, startBlock,
 *     endBlock, startOffset, endOffset, pageIndex, pageLabel, position,
 *     sectionPart, sectionParts, auxiliary }>} - in document order
 */
export function getPassages(structure) {
	const sections = getStructureSections(structure, { onlyIndexable: true });
	if (!sections.length) return [];
	return buildPassages(sections);
}

/**
 * The passages of a flat text, for documents with no structure: as few and
 * as even as possible within the budget, cut at paragraph boundaries; a
 * paragraph over the budget is cut at sentence boundaries.
 *
 * @param {string} text
 * @param {Object} [geometry] - budget, minSize and overlap in characters;
 *     the text's own scale when omitted
 * @returns {Array<{ text, size, start, end }>}
 */
export function getTextPassages(text, geometry) {
	if (!text || !text.trim()) return [];
	geometry = geometry || getCharacterMetrics(text);
	return splitParagraphs(text, measureParagraphs(text), geometry);
}

/**
 * A fingerprint of the passages' words, whitespace collapsed
 *
 * @param {Array<{ text: string }>} passages
 * @returns {string} - 16 hex characters
 */
export function getPassageDigest(passages) {
	// Two passes from different starting states: one hash is 32 bits, too
	// narrow to tell two divisions apart across a library. The first basis
	// is FNV's own, the second is arbitrary.
	const FIRST_BASIS = 0x811c9dc5;
	const SECOND_BASIS = 0x5c6f2a91;
	const joined = passages
		.map(passage => passage.text.replace(/\s+/g, ' ').trim())
		.join('\n');
	return fnv1a32(joined, FIRST_BASIS) + fnv1a32(joined, SECOND_BASIS);
}

/**
 * The first passage starting at or after a block, or null. Pass the previous
 * passage's endBlock + 1 to walk a document.
 */
export function getNextPassage(structure, startBlockIndex) {
	if (!structure || typeof structure !== 'object') return null;
	let passages = passageCache.get(structure);
	if (!passages) {
		passages = getPassages(structure);
		passageCache.set(structure, passages);
	}
	return passages.find(passage => passage.startBlock >= startBlockIndex) || null;
}

/**
 * A document's text as outline sections, each running from one heading to
 * the next, or one section without an outline. Excluded blocks (running
 * heads, page numbers) are left out; the rest is reported with its flow
 * class and reference flag, `text` being the blocks joined with newlines.
 *
 * Location is what the document knows: pageIndex, pageLabel (the ordinal
 * for a PDF without labels, none for EPUB locations), and for PDFs a
 * position { pageIndex, rects }. A section is located at its heading, else
 * at its first block.
 *
 * With `onlyIndexable`, reference entries and auxiliary blocks are left out
 * too, a section starts at its first remaining block, and an emptied section
 * is dropped.
 *
 * @param {Object} structure - A materialized structure
 * @param {Object} [options]
 * @param {boolean} [options.onlyIndexable=false]
 * @returns {Array<{ text, outlinePath, startBlock, endBlock, pageIndex,
 *     pageLabel, position, blocks: Array<{ index, text, flowClass,
 *     reference, pageIndex, pageLabel, position }> }>}
 */
export function getStructureSections(structure, { onlyIndexable = false } = {}) {
	const content = Array.isArray(structure?.content) ? structure.content : [];
	if (!content.length) return [];
	const catalog = structure.catalog;
	const boundaries = flattenOutline(catalog?.outline, [])
		.filter(b => b.blockIndex < content.length)
		.sort((a, b) => a.blockIndex - b.blockIndex);
	const blockPages = getBlockPages(catalog, content.length);

	const sections = [];
	let startBlock = 0;
	let path = [];
	let isHeading = false;
	for (const boundary of [...boundaries, { blockIndex: content.length, path }]) {
		if (boundary.blockIndex > startBlock) {
			const endBlock = boundary.blockIndex - 1;
			const blocks = [];
			let location = null;
			// A heading's text is already the last component of the path
			for (let i = startBlock + (isHeading ? 1 : 0); i <= endBlock; i++) {
				const block = content[i];
				if (!block || block.flowClass === 'excluded') continue;
				const reference = isReferenceBlock(block);
				if (onlyIndexable && (reference || block.flowClass === 'auxiliary')) continue;
				const text = getNestedBlockPlainText(block).trim();
				if (!text) continue;
				const entry = { index: i, text, reference };
				if (block.flowClass) entry.flowClass = block.flowClass;
				const blockLocation = getBlockLocation(block, catalog, structure.metadata, blockPages, i);
				location = location || blockLocation;
				blocks.push(Object.assign(entry, blockLocation));
			}
			if (blocks.length) {
				const start = getBlockLocation(content[startBlock], catalog, structure.metadata, blockPages, startBlock);
				sections.push(Object.assign({
					text: blocks.map(block => block.text).join('\n'),
					outlinePath: path.join(' > '),
					startBlock: onlyIndexable ? blocks[0].index : startBlock,
					endBlock,
				}, start.pageIndex === undefined ? location : start, { blocks }));
			}
		}
		startBlock = boundary.blockIndex;
		path = boundary.path;
		isHeading = !!boundary.isHeading;
	}
	return sections;
}

/**
 * The sentences of a text, whole, each located within it
 *
 * @returns {Array<{ text: string, size: number, start: number, end: number }>}
 */
export function splitSentences(text) {
	return segmentSentences(text, 0, text.length);
}

/**
 * The token geometry in characters, at the text's chars-per-token scale
 *
 * @returns {{ budget: number, minSize: number, overlap: number }}
 */
export function getCharacterMetrics(text) {
	return geometryFor(getCharsPerToken(text));
}

/**
 * Estimated token count of a text
 */
export function estimateTokens(text) {
	return Math.round(text.length / getCharsPerToken(text));
}


// ---------------------------------------------------------------------------
// Structure walk
// ---------------------------------------------------------------------------

// Outline entries flattened to block indexes, each with its heading path
function flattenOutline(items, ancestors) {
	const result = [];
	if (!Array.isArray(items)) return result;
	for (const item of items) {
		if (!item || typeof item !== 'object' || typeof item.title !== 'string') continue;
		const blockIndex = Array.isArray(item.ref) && Number.isInteger(item.ref[0])
			? item.ref[0]
			: null;
		const path = [...ancestors, item.title];
		if (blockIndex !== null && blockIndex >= 0) {
			result.push({ blockIndex, path, isHeading: true });
		}
		result.push(...flattenOutline(item.children, path));
	}
	return result;
}

// blockIndex -> pageIndex: the last page starting at or before the block
function getBlockPages(catalog, blockCount) {
	const pages = Array.isArray(catalog?.pages) ? catalog.pages : [];
	const starts = [];
	for (let i = 0; i < pages.length; i++) {
		const start = pages[i]?.contentRange?.[0]?.[0];
		if (Number.isInteger(start) && start >= 0) {
			starts.push({ start, pageIndex: i });
		}
	}
	starts.sort((a, b) => a.start - b.start);
	const blockPages = new Array(blockCount).fill(null);
	let current = null;
	let next = 0;
	for (let i = 0; i < blockCount; i++) {
		while (next < starts.length && starts[next].start <= i) {
			current = starts[next].pageIndex;
			next++;
		}
		blockPages[i] = current;
	}
	return blockPages;
}

// A block's page and, for PDFs, its rects; only what's known is returned
function getBlockLocation(node, catalog, metadata, blockPages, index) {
	const location = {};
	const pageRects = node?.anchor?.pageRects;
	let pageIndex = null;
	if (Array.isArray(pageRects) && pageRects.length && Number.isInteger(pageRects[0][0])) {
		pageIndex = pageRects[0][0];
		const rects = pageRects
			.filter(rect => rect[0] === pageIndex && rect.length >= 5)
			.map(rect => rect.slice(1));
		if (rects.length) {
			location.position = { pageIndex, rects };
		}
	}
	if (pageIndex === null) pageIndex = blockPages[index];
	if (pageIndex === null) return location;
	location.pageIndex = pageIndex;
	// EPUB locations aren't page numbers
	if (catalog?.pageMappingType !== 'locations') {
		let label = catalog?.pages?.[pageIndex]?.label;
		if (!label && metadata?.processor?.type === 'pdf') {
			label = String(pageIndex + 1);
		}
		if (label) location.pageLabel = label;
	}
	return location;
}

// Flagged by the processor, or made up entirely of blocks that are
// references themselves
function isReferenceBlock(node) {
	if (node.reference) return true;
	const children = Array.isArray(node.content)
		? node.content.filter(child => child.text === undefined)
		: [];
	return children.length > 0 && children.every(isReferenceBlock);
}


// ---------------------------------------------------------------------------
// Passages from sections
// ---------------------------------------------------------------------------

/**
 * Split sections into passages that fit the budget. A section is the topic
 * unit: one large enough is a passage of its own, one over the budget is
 * split at paragraph then sentence boundaries. Consecutive small sections
 * accumulate until the run reaches MIN_TOKENS; a trailing run still under
 * it joins the passage before. Auxiliary sections (captions) always stand
 * alone.
 *
 * `embedText` weaves each section's outline path in where its text begins;
 * `text` is the plain piece. Each passage records the blocks it covers with
 * offsets into the first and last, so its text can be re-derived from the
 * blocks. Location is the first covered block's.
 *
 * Each run is sized at its own chars-per-token scale, so a section in
 * another script than the rest of the document gets its own budget.
 *
 * Each section's `text` must be its blocks joined with single newlines.
 *
 * @param {Array<{ text, outlinePath, startBlock, auxiliary, blocks:
 *     Array<{ index, text, pageIndex, pageLabel, position }> }>} sections
 * @returns {Array<{ text, embedText, size, outlinePath, startBlock,
 *     endBlock, startOffset, endOffset, pageIndex, pageLabel, position,
 *     sectionPart, sectionParts, auxiliary }>} - size counts embedText
 */
function buildPassages(sections) {
	const passages = [];
	for (const group of groupSections(sections)) {
		const source = assembleGroup(group);
		// The group's characters over its sections' tokens
		const chars = group.entries.reduce((sum, entry) => sum + entry.chars, 0);
		const tokens = group.entries.reduce((sum, entry) => sum + entry.tokens, 0);
		const geometry = geometryFor(chars / tokens);
		const { headings, headingSize } = pickHeadings(source, geometry.budget);
		const pieces = splitParagraphs(source.text, source.paragraphs,
			{ ...geometry, budget: geometry.budget - headingSize });
		for (let i = 0; i < pieces.length; i++) {
			passages.push(describePiece(source, headings, pieces[i], {
				sectionPart: i + 1,
				sectionParts: pieces.length,
				auxiliary: !!group.auxiliary,
			}));
		}
	}
	return passages;
}

// Sections grouped into runs: a section at or over MIN_TOKENS stands alone,
// smaller ones accumulate until the run reaches it, auxiliary sections
// always stand alone (nothing produces them yet). Each section is measured
// once: its paragraphs, and its estimated tokens at its own scale.
//
// @returns {Array<{ entries: Array<{ section, paragraphs, chars, tokens }>,
//     auxiliary }>}
function groupSections(sections) {
	const groups = [];
	let pending = null;
	let lastBodyGroup = -1;
	for (const section of sections) {
		if (!section.text) continue;
		const paragraphs = measureParagraphs(section.text);
		const chars = sumSizes(paragraphs);
		const tokens = chars / getCharsPerToken(section.text);
		const entry = { section, paragraphs, chars, tokens };
		if (section.auxiliary) {
			groups.push({ entries: [entry], auxiliary: true });
			continue;
		}
		if (pending) {
			pending.entries.push(entry);
			pending.tokens += tokens;
		}
		else {
			pending = { entries: [entry], tokens };
		}
		if (pending.tokens >= MIN_TOKENS) {
			lastBodyGroup = groups.length;
			groups.push(pending);
			pending = null;
		}
	}
	// A trailing run under the minimum joins the previous body group, never
	// an auxiliary one
	if (pending) {
		if (lastBodyGroup >= 0) {
			groups[lastBodyGroup].entries.push(...pending.entries);
		}
		else {
			groups.push(pending);
		}
	}
	// Body runs can close after an auxiliary group they precede
	return groups.sort((a, b) => (a.entries[0].section.startBlock ?? 0)
		- (b.entries[0].section.startBlock ?? 0));
}

// A group's sections joined into one string, with paragraphs and block
// extents shifted into place and each section's start kept for headings
//
// @returns {{ text, paragraphs, blocks, starts: Array<{ start, path }> }}
function assembleGroup(group) {
	let text = '';
	const paragraphs = [];
	const blocks = [];
	const starts = [];
	for (const entry of group.entries) {
		if (text) text += '\n\n';
		const base = text.length;
		starts.push({ start: base, path: entry.section.outlinePath || '' });
		for (const paragraph of entry.paragraphs) {
			paragraphs.push({
				...paragraph,
				start: base + paragraph.start,
				end: base + paragraph.end,
			});
		}
		let blockStart = base;
		for (const block of entry.section.blocks || []) {
			blocks.push({
				index: block.index,
				start: blockStart,
				end: blockStart + block.text.length,
				pageIndex: block.pageIndex ?? null,
				pageLabel: block.pageLabel ?? null,
				position: block.position ?? null,
			});
			blockStart += block.text.length + 1;
		}
		text += entry.section.text;
	}
	return { text, paragraphs, blocks, starts };
}

// The headings a group's passages carry, each spanning its section, and the
// budget reserved for them. A heading repeating the one before is dropped,
// as is one over a quarter of the budget; if all together exceed a quarter,
// only the first is kept.
function pickHeadings(source, budget) {
	const { starts, text } = source;
	let headings = starts
		.map((section, j) => ({
			...section,
			end: starts[j + 1] ? starts[j + 1].start : text.length,
			size: section.path.length + JOIN_SIZE,
		}))
		.filter((heading, j) => heading.path
			&& heading.path !== starts[j - 1]?.path
			&& heading.path.length <= budget / 4);
	let headingSize = headings.reduce((sum, heading) => sum + heading.size, 0);
	if (headingSize > budget / 4) {
		headings = headings.slice(0, 1);
		headingSize = headings.length ? headings[0].size : 0;
	}
	return { headings, headingSize };
}

// A piece as a passage: located in the blocks it covers, with the headings
// it reaches woven into its embed text where each section starts
function describePiece(source, headings, piece, part) {
	const { text, blocks } = source;
	// Paragraphs never span the newline between blocks, so a piece boundary
	// always falls inside a block
	const covered = blocks.filter(block => block.end > piece.start && block.start < piece.end);
	const first = covered[0];
	const last = covered[covered.length - 1];
	let embedText = '';
	let embedSize = piece.size;
	let emitted = '';
	let cursor = piece.start;
	for (const heading of headings) {
		if (heading.end <= piece.start || heading.start >= piece.end || heading.path === emitted) {
			continue;
		}
		const at = Math.max(heading.start, piece.start);
		embedText += text.slice(cursor, at) + heading.path + '\n\n';
		embedSize += heading.size;
		emitted = heading.path;
		cursor = at;
	}
	embedText += text.slice(cursor, piece.end);
	return {
		text: piece.text,
		embedText,
		size: embedSize,
		outlinePath: headings.find(
			heading => heading.end > piece.start && heading.start < piece.end
		)?.path || '',
		startBlock: first ? first.index : null,
		endBlock: last ? last.index : null,
		startOffset: first ? piece.start - first.start : null,
		endOffset: last ? piece.end - last.start : null,
		pageIndex: first ? first.pageIndex : null,
		pageLabel: first ? first.pageLabel : null,
		position: first ? first.position : null,
		...part,
	};
}


// ---------------------------------------------------------------------------
// Paragraph splitting
// ---------------------------------------------------------------------------

function splitParagraphs(text, paragraphs, { budget, minSize, overlap }) {
	if (!paragraphs.length) {
		return [{ text, size: 0, start: 0, end: text.length }];
	}
	const totalSize = sumSizes(paragraphs);
	if (totalSize <= budget) {
		return [sliceUnits(text, paragraphs, totalSize)];
	}
	const groups = partitionEvenly(paragraphs, totalSize, budget);
	absorbUndersized(groups, minSize);
	const pieces = [];
	for (const group of groups) {
		const block = sliceUnits(text, group, sumSizes(group));
		if (block.size <= budget) {
			pieces.push(block);
		}
		else {
			pieces.push(...splitBlockEvenly(text, block, budget, overlap));
		}
	}
	return pieces;
}

// Paragraphs in as few and as even groups as possible. The target is
// recomputed from what's left, so slack spreads instead of piling up in a
// short last group.
function partitionEvenly(paragraphs, totalSize, budget) {
	const groups = [];
	let current = [];
	let currentSize = 0;
	let remainingSize = totalSize;
	let remainingGroups = Math.ceil(totalSize / budget);
	for (const paragraph of paragraphs) {
		const withNext = currentSize + JOIN_SIZE + paragraph.size;
		// Close at whichever boundary lands nearer the target
		let closeHere = false;
		if (current.length) {
			if (withNext > budget) {
				closeHere = true;
			}
			else if (remainingGroups > 1) {
				const target = remainingSize / remainingGroups;
				closeHere = Math.abs(withNext - target) > Math.abs(currentSize - target);
			}
		}
		if (closeHere) {
			groups.push(current);
			remainingSize -= currentSize + JOIN_SIZE;
			remainingGroups = Math.max(1, remainingGroups - 1);
			current = [];
			currentSize = 0;
		}
		currentSize += (current.length ? JOIN_SIZE : 0) + paragraph.size;
		current.push(paragraph);
	}
	if (current.length) groups.push(current);
	return groups;
}

// A group under the minimum merges into its smaller neighbor. The result can
// exceed the budget, which leaves it to the sentence splitter.
function absorbUndersized(groups, minSize) {
	let i = 0;
	while (groups.length > 1 && i < groups.length) {
		if (sumSizes(groups[i]) >= minSize) {
			i++;
			continue;
		}
		const before = i > 0 ? sumSizes(groups[i - 1]) : Infinity;
		const after = i < groups.length - 1 ? sumSizes(groups[i + 1]) : Infinity;
		if (before <= after) {
			groups[i - 1].push(...groups[i]);
		}
		else {
			groups[i + 1].unshift(...groups[i]);
		}
		groups.splice(i, 1);
	}
}

// An oversized block in as few and as even pieces as possible, cut at
// sentence boundaries, each carrying overlap from the piece before
function splitBlockEvenly(source, block, budget, overlap) {
	const pieceCount = Math.ceil(block.size / (budget - overlap));
	const sentences = splitToSentences(source, block.start, block.end, budget);
	const pieces = [];
	let current = [];
	let carriedSize = 0;
	let totalSize = 0;
	let remainingSize = block.size;
	let remainingPieces = pieceCount;
	for (const sentence of sentences) {
		const contentSize = totalSize - carriedSize;
		let closeHere = false;
		if (current.length) {
			if (totalSize + sentence.size > budget) {
				closeHere = true;
			}
			else if (remainingPieces > 1) {
				const target = Math.ceil(remainingSize / remainingPieces);
				closeHere = Math.abs(contentSize + sentence.size - target)
					> Math.abs(contentSize - target);
			}
		}
		if (closeHere) {
			pieces.push(sliceUnits(source, current, totalSize));
			remainingSize -= contentSize;
			remainingPieces = Math.max(1, remainingPieces - 1);
			// Carry the trailing sentences that fit the overlap
			const carry = [];
			carriedSize = 0;
			const allowance = Math.min(overlap, budget - sentence.size);
			for (let i = current.length - 1; i >= 0; i--) {
				if (carriedSize + current[i].size <= allowance) {
					carry.unshift(current[i]);
					carriedSize += current[i].size;
					continue;
				}
				// No whole sentence fits: carry the tail of the last one
				if (!carry.length) {
					const tail = tailOf(source, current[i], allowance);
					if (tail) {
						carry.unshift(tail);
						carriedSize = tail.size;
					}
				}
				break;
			}
			current = carry;
			totalSize = carriedSize;
		}
		current.push(sentence);
		totalSize += sentence.size;
	}
	if (current.length) {
		pieces.push(sliceUnits(source, current, totalSize));
	}
	return pieces;
}

// A unit's last `size` characters, from the first word boundary in reach so
// the tail doesn't open mid-word, or null when there's no room for one
function tailOf(source, unit, size) {
	if (size <= 0) return null;
	let start = Math.max(unit.start, unit.end - Math.floor(size));
	const limit = Math.min(unit.end, start + Math.ceil(size / 4));
	for (let i = start; i < limit; i++) {
		if (/\s/.test(source[i])) {
			start = i + 1;
			break;
		}
	}
	return measureRange(source, start, unit.end);
}

function sliceUnits(source, units, size) {
	const start = units[0].start;
	const end = units[units.length - 1].end;
	return { text: source.slice(start, end), size, start, end };
}


// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

// Sentences of a range, each within the budget
function splitToSentences(source, start, end, budget) {
	const units = [];
	for (const unit of segmentSentences(source, start, end)) {
		if (unit.size <= budget) {
			units.push(unit);
			continue;
		}
		units.push(...hardSplit(source, unit, budget));
	}
	return units;
}

// Sentences of a range, whatever their size
function segmentSentences(source, start, end) {
	const units = [];
	if (!sentenceSegmenter) {
		// Sentence rules don't vary by locale, but the default locale varies by machine, so pin one
		const SENTENCE_LOCALE = 'en';
		sentenceSegmenter = new Intl.Segmenter(SENTENCE_LOCALE, { granularity: 'sentence' });
	}
	for (const { segment, index } of sentenceSegmenter.segment(source.slice(start, end))) {
		const unit = measureRange(source, start + index, start + index + segment.length);
		if (unit) units.push(unit);
	}
	return units;
}

// Bisect at whitespace until every piece fits
function hardSplit(source, unit, budget) {
	if (unit.size <= budget || unit.end - unit.start < 2) return [unit];
	const mid = unit.start + Math.floor((unit.end - unit.start) / 2);
	let split = mid;
	for (let i = 0; i < (unit.end - unit.start) / 2 - 1; i++) {
		if (/\s/.test(source[mid - i])) {
			split = mid - i;
			break;
		}
		if (/\s/.test(source[mid + i])) {
			split = mid + i;
			break;
		}
	}
	const halves = [
		measureRange(source, unit.start, split),
		measureRange(source, split, unit.end),
	];
	return halves.filter(Boolean).flatMap(half => hardSplit(source, half, budget));
}


// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

// Characters per token, estimated from the text's character classes. Each
// class's characters are counted once, in table order, and the estimate is
// the text's length over the tokens its classes add up to.
function getCharsPerToken(text) {
	// Digits and punctuation cost about a token each in every tokenizer;
	// alphabetic scripts pack several characters into one; CJK a little over
	// one. Letters of any other script are assumed midway.
	const CHARS_PER_TOKEN = [
		[/\p{Nd}/gu, 1],
		[/\p{Script=Latin}/gu, 4],
		[/\p{Script=Cyrillic}/gu, 3],
		[/\p{Script=Greek}/gu, 2],
		[/[\p{Script=Arabic}\p{Script=Hebrew}]/gu, 2.5],
		[/[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]/gu, 2],
		[/[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu, 1.5],
		[/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, 1.4],
		[/[\p{L}\p{M}]/gu, 2],
	];
	const OTHER_CHARS_PER_TOKEN = 1;
	// Whitespace costs nothing: tokenizers fold it into the word after it
	const length = text.length;
	let rest = text.replace(/\s/g, '');
	if (!rest) return OTHER_CHARS_PER_TOKEN;
	let tokens = 0;
	for (const [pattern, charsPerToken] of CHARS_PER_TOKEN) {
		const before = rest.length;
		rest = rest.replace(pattern, '');
		tokens += (before - rest.length) / charsPerToken;
	}
	tokens += rest.length / OTHER_CHARS_PER_TOKEN;
	return length / tokens;
}

// The token geometry in characters at a chars-per-token scale
function geometryFor(scale) {
	return {
		budget: BUDGET_TOKENS * scale,
		minSize: MIN_TOKENS * scale,
		overlap: OVERLAP_TOKENS * scale,
	};
}

function measureParagraphs(text) {
	const paragraphs = [];
	for (const match of text.matchAll(/[^\n]+/g)) {
		const unit = measureRange(text, match.index, match.index + match[0].length);
		if (unit) paragraphs.push(unit);
	}
	return paragraphs;
}

// The trimmed extent of a range, or null when it's all whitespace
function measureRange(text, start, end) {
	const raw = text.slice(start, end);
	const trimmed = raw.trim();
	if (!trimmed) return null;
	start += raw.length - raw.trimStart().length;
	return { text: trimmed, size: trimmed.length, start, end: start + trimmed.length };
}

// The size of the units joined
function sumSizes(units) {
	if (!units.length) return 0;
	return units.reduce((sum, unit) => sum + unit.size, 0) + JOIN_SIZE * (units.length - 1);
}


// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

// FNV-1a over UTF-16 code units, as 8 hex characters
function fnv1a32(text, seed) {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}
