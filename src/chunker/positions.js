import { PDFPositionMapper } from './pdf.js';
import { EPUBPositionMapper } from './epub.js';
import { SnapshotPositionMapper } from './snapshot.js';
import { getDocument, mergeSpans, spansText } from './document.js';
import { iterateChunks } from './chunks.js';

const formats = { pdf: PDFPositionMapper, epub: EPUBPositionMapper, snapshot: SnapshotPositionMapper };
const mappers = new WeakMap();

/**
 * Split text and attach existing reader positions before discarding source spans.
 * DOM element anchors provide locations for synthetic text; PDF text requires text maps.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./positions').Chunk[]}
 */
export function getChunks(structure, options) {
	let mapper = getMapper(structure);
	if (!mapper) throw new TypeError('Unsupported SDT processor type');
	let chunks = [];
	for (let { spans, ...chunk } of iterateChunks(structure, options)) {
		let positions = mapper.toPositions(spans);
		if (!positions?.length || positions.some(position => !position)) {
			positions = [];
		}
		chunks.push({ ...chunk, positions });
	}
	return chunks;
}

/**
 * Recover saved positions without rerunning the chunker or inclusion policy.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./positions').Position[]} positions
 * @returns {string | null}
 */
export function getPositionsText(structure, positions) {
	if (!Array.isArray(positions) || !positions.length
			|| positions.some(position => !position || typeof position !== 'object' || Array.isArray(position))) return null;
	let spans = getMapper(structure)?.toSpans(positions);
	return spans?.length ? spansText(mergeSpans(spans)) : null;
}

function getMapper(structure) {
	let type = structure.metadata?.processor?.type;
	let Mapper = Object.hasOwn(formats, type) && formats[type];
	if (!Mapper) return null;
	let document = getDocument(structure);
	if (!mappers.has(document)) {
		mappers.set(document, new Mapper(document));
	}
	return mappers.get(document);
}
