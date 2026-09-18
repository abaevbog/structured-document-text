# Structured Document Text

Structured Document Text (SDT) is Zotero's structured text format for documents.

SDT stores a normalized document tree together with document metadata, outline, page mappings, source anchors, and text ranges needed for reading, annotation, search, and retrieval workflows. It is currently produced for PDFs, EPUBs, and web snapshots.

The logical SDT model is:

```js
{
  schemaVersion,
  metadata,
  catalog,
  content
}
```

`metadata` describes the processor and source document. `catalog` contains document-level structures that point into content, including pages and outline. `content` contains the top-level structured text blocks.

The default persisted form is a binary `.sdt` pack. JSON is used internally and for debugging and streaming workflows.

## Use Cases

- Reading mode (Desktop/iOS/Android/Web) with text annotations
- Text layer for the Zotero Reader PDF viewer
- Outline preview outside the Reader (e.g., in the item pane)
- Structured context for agents
- Section-level passages for embeddings
- Disk-backed or remote random access (e.g., S3) to large documents

## SDT Pack

An SDT pack stores the logical SDT model in a compact binary container optimized for random access.

The file is organized roughly as:

```text
header
index
metadata
catalog
content chunks
```

The header identifies the file as SDT and stores the pack/schema version. The index stores the metadata and catalog sizes plus the content chunk offsets and block boundaries.

`metadata` and `catalog` are stored as separate compressed JSON sections. `content` is split into compressed chunks of top-level blocks. Each content chunk includes a small block offset table, so a reader can extract individual blocks after reading only the relevant chunk.

This layout lets consumers read metadata, pages, outline, selected blocks, or the full document depending on what they need, without always loading and parsing the whole structure. Memory use can stay bounded by the sections or chunks being accessed, and small reads remain fast even across many SDT files.

SDT packs are produced by `document-worker`.

## Passages

`src/chunker.js` divides a document into passages for embedding, following its structure and sized in estimated tokens.

- `getPassages(structure)`: the passages of a materialized structure. Sections run from one outline heading to the next, or the whole document is one section without an outline; reference entries and auxiliary blocks are dropped. A section large enough stands as a passage of its own; consecutive small sections are combined in document order until the run reaches the minimum passage size; a section or run over the budget is split at paragraph, then sentence, boundaries. Each passage carries its plain `text`, an `embedText` with the section's outline path woven in, its `size` in characters and estimated `tokens`, the block range it covers with offsets into its first and last block, and the first block's page.
- `getPassagePosition(structure, passage)`: a passage's position in the source document's own coordinates, in the stored form the document's position mapper defines, so it survives a re-extraction that divides the document into different blocks.
- `getPositionText(structure, position)`: the text a passage's position covers in a structure, with the block range it spans in a passage's terms -- the inverse of `getPassagePosition`, and usable on a different extraction of the same document.
- `getBlockRangeText(structure, range)`: the text of a passage's block range, located like a passage. The structure need hold only the range's blocks, as a pack reader's `materializeBlocks(startBlock, endBlock)` gives it, so a passage reads back at the cost of the pack chunks holding its blocks.
- `createPositionMapper(structure)` in `src/position.js` is the mapper behind these, converting between content points and the document's own coordinates in both directions; `expandPosition(processorType, compact)` puts a stored position back in the form the mapper takes, with no structure at hand.
- `getTextPassages(text, geometry?)`: the same division for a flat text with no structure, optionally at a custom budget.
- `getPassageDigest(passages)`: a fingerprint of the passages' words, for checking that two runs divided a document the same way.
- `splitSentences`: the sentences of a text, located within it.

Passages are sized in estimated tokens (`BUDGET_TOKENS`, `MIN_TOKENS`, `OVERLAP_TOKENS`) from characters at a chars-per-token scale estimated from the text's scripts, with no tokenizer and no model involved. The scale is taken per section run, so a section in another script than the rest of the document, an English abstract in a Chinese paper, is sized for its own script. The budget is a ceiling on estimated tokens for splitting, not a fill target: real token counts run past it when the estimate undercounts, and an embedding model's window has to leave room for that.
