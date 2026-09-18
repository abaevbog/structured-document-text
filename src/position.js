import { PDFPositionMapper } from './pdf/position.js';
import { EPUBPositionMapper } from './dom/epub/position.js';
import { SnapshotPositionMapper } from './dom/snapshot/position.js';

/**
 * A mapper between the structure's content-tree positions and positions in
 * the source document's own coordinate system: page rects for a PDF, a CFI
 * for an EPUB, a selector for a snapshot.
 *
 * Ported from the reader's src/common/sdt/create-position-mapper.ts
 *
 * @param {Object} structure - A materialized structure
 * @returns {Object} - With sdtToSourcePosition, textNodeSpansToSourcePosition
 *     and sourceToSDTPosition, plus compactPosition and expandPosition
 *     between a source position and its stored form
 * @throws {Error} - On a processor type with no mapper
 */
export function createPositionMapper(structure) {
	switch (structure.metadata.processor.type) {
		case 'pdf':
			return new PDFPositionMapper(structure);
		case 'epub':
			return new EPUBPositionMapper(structure);
		case 'snapshot':
			return new SnapshotPositionMapper(structure);
		default:
			throw new Error(`Unsupported SDT processor type: ${structure.metadata.processor.type}`);
	}
}

/**
 * A stored position in the form a mapper's other methods take -- what a
 * mapper's expandPosition() gives, without a structure to make a mapper
 * from: the conversion is one of form alone.
 *
 * @param {string} processorType - The document's processor type
 * @param {Object|string|Array} compact - A position in its stored form
 * @returns {Object|null}
 * @throws {Error} - On a processor type with no mapper
 */
export function expandPosition(processorType, compact) {
	switch (processorType) {
		case 'pdf':
			return PDFPositionMapper.expandPosition(compact);
		case 'epub':
			return EPUBPositionMapper.expandPosition(compact);
		case 'snapshot':
			return SnapshotPositionMapper.expandPosition(compact);
		default:
			throw new Error(`Unsupported SDT processor type: ${processorType}`);
	}
}
