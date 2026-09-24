import { iterateChunks } from './chunks.js';

export const CHUNKER_VERSION = 1;

/**
 * Split an immutable, materialized SDT. No source geometry is decoded.
 * @param {import('../../schema').StructuredDocumentText} structure
 * @param {import('./text').ChunkingOptions} [options]
 * @returns {import('./text').TextChunk[]}
 */
export function getTextChunks(structure, options) {
	return Array.from(iterateChunks(structure, options, false));
}
