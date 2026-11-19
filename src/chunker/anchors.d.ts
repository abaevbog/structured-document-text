import type { ContentBlockNode, RefPath, StructuredDocumentText, TextStyle } from '../../schema.js';
import type { ChunkingOptions, ChunkContent, TextChunk } from './text.js';

export interface PDFPosition {
	pageIndex: number;
	rects: [number, number, number, number][];
	/** Existing adjacent-page Reader representation. */
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

export interface PDFChunkAnchor {
	pageRects: [pageIndex: number, left: number, bottom: number, right: number, top: number][];
}
export interface DOMChunkAnchor {
	selectors: (FragmentSelector | TextPositionSelector | CssSelector)[];
}
export type ChunkAnchor = PDFChunkAnchor | DOMChunkAnchor;

export interface Chunk extends TextChunk {
	/** Source coverage, which can exceed the chunk text; null if mapping fails. */
	anchor: ChunkAnchor | null;
}
/** Selected text with its source positions */
export interface AnchorSelection extends ChunkContent {
	positions: Position[];
}
/** A block as it stands over a segment's text: its type and ref, and a list's numbering */
export interface SegmentBlock {
	type: ContentBlockNode['type'];
	ref: RefPath;
	ordered?: boolean;
	startIndex?: number;
}
/** A stretch of recovered text from one text node */
export interface TextSegment {
	/** Offsets into the recovered text */
	start: number;
	end: number;
	/** The text node's ref, and the offset into its text the segment starts at */
	ref: RefPath;
	offset: number;
	/** The blocks over the text node, the outermost first and the one holding it last */
	blocks: SegmentBlock[];
	style?: TextStyle;
}
/** A content point: a text node's ref with an offset into its text, [...ref, offset] */
export type ContentPoint = number[];
/** A document-order range between two content points, as makeContentRange() builds one */
export type ContentRange = [ContentPoint, ContentPoint];

/** Returns serializable chunks with source locations attached. DOM text may use broader element anchors.
 * Text without source anchors is omitted before chunking. Unresolvable mappings yield anchor: null.
 * Unsupported formats and unexpected programming errors still throw. */
export function getChunks(structure: StructuredDocumentText, options?: ChunkingOptions): Chunk[];
/** Reads covered text in document order, with the section and page at the first recovered text.
 * The text may differ from the chunk text or be empty after trimming.
 * Returns null for invalid anchors or unresolved pages/selectors. Individual empty PDF rectangles are tolerated. */
export function getAnchorContent(structure: StructuredDocumentText, anchor: ChunkAnchor | null): ChunkContent | null;
/** The structure of recovered text, segment by segment, in the text's order */
export function getAnchorSegments(structure: StructuredDocumentText, anchor: ChunkAnchor | null): TextSegment[] | null;
/** Locate content ranges of the structure's text as a selection: their text and the source
 * positions the reader would store it as */
export function getRangeSelection(structure: StructuredDocumentText, ranges: ContentRange[]): AnchorSelection | null;
/** Locate positions in the structure's text: per position, the content ranges of the text it covers,
 * one per text node in document order, or null for one on none of it */
export function getPositionRanges(structure: StructuredDocumentText, positions: Position[]): Array<ContentRange[] | null>;
/** Restores ordinary PDF line positions, one per page, or copies DOM selectors.
 * DOM conversion does not verify text recovery or Reader resolution. */
export function getAnchorPositions(structure: StructuredDocumentText, anchor: ChunkAnchor | null): Position[] | null;
