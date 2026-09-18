// Generic utilities (work with any structured text)
export { getFulltextFromStructuredText } from './fulltext.js';
export { exportOutline } from './outline.js';
export {
	getCharacterMetrics,
	estimateTokens,
	splitSentences,
	getStructureSections,
	getPassages,
	getPositionText,
	getTextPassages,
	getPassageDigest,
	getNextPassage,
} from './chunker.js';

export { createPositionMapper } from './position.js';
export { getTextNodeSpans } from './range.js';

// EPUB selectorMap decode
export {
	expandBlockAnchor as expandEpubBlockAnchor,
	expandSelectorMap as expandEpubSelectorMap,
	resolveSelectorMap as resolveEpubSelectorMap,
	resolveSelectorMapRange as resolveEpubSelectorMapRange,
	parseSelectorMapEntries as parseEpubSelectorMapEntries,
	findCommonCFIPath,
} from './dom/epub/decode.js';

// Snapshot domMap (selector resolution and generation)
export {
	buildDomMapIndex,
	findDomMapContaining,
	generateDomMapSelector,
	matchDomMapSelector,
} from './dom/snapshot/dommap.js';
