import type { StructuredDocumentText } from '../../schema.js';
import type { ChunkingOptions, TextChunk } from './text.js';

export interface PDFPosition {
	pageIndex: number;
	rects: [number, number, number, number][];
	/** Existing adjacent-page representation, accepted when reading positions. */
	nextPageRects?: [number, number, number, number][];
}
export interface FragmentSelector {
	type: 'FragmentSelector';
	conformsTo: 'http://www.idpf.org/epub/linking/cfi/epub-cfi.html';
	value: string;
}
export interface TextPositionSelector {
	type: 'TextPositionSelector';
	start: number;
	end: number;
}
export interface CssSelector {
	type: 'CssSelector';
	value: string;
	refinedBy?: TextPositionSelector;
}
/** Existing reader source positions; no multi-page extension to their shapes. */
export type Position = PDFPosition | FragmentSelector | TextPositionSelector | CssSelector;

export interface Chunk extends TextChunk {
	/** Source locations, which can cover more than the chunk text; empty if mapping fails. */
	positions: Position[];
}

/** Returns serializable chunks with source locations attached. DOM text may use broader element anchors.
 * Text without source anchors is omitted before chunking. Unresolvable anchors yield positions: [].
 * Unsupported formats and unexpected programming errors still throw. */
export function getChunks(structure: StructuredDocumentText, options?: ChunkingOptions): Chunk[];
/** Reads covered text in document order; it may differ from the chunk text or be empty after trimming.
 * Returns null for empty positions or an unresolved member; gaps within resolved selections are tolerated. */
export function getPositionsText(structure: StructuredDocumentText, positions: Position[]): string | null;
