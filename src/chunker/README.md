# Passage chunker

The optional `src/chunker/` module splits one materialized PDF, EPUB or snapshot
SDT into source excerpts, embedding input and Reader positions. Treat the input
as immutable. These passages are separate from SDT pack storage chunks.

## Usage

```js
import { getChunks, getPositionsText } from 'structured-document-text/src/chunker/index.js';

const chunks = getChunks(structure);
for (const chunk of chunks) {
    // Use chunk.embedText for embeddings and chunk.text as the source excerpt.
    const saved = JSON.stringify(chunk.positions);
    const coveredText = getPositionsText(structure, JSON.parse(saved));
    // coveredText can differ from chunk.text or be null.
}
```

For text alone, import `getTextChunks` from `src/chunker/text.js`. It accepts the
same options and returns the same fields except `positions`, without loading
position mappers or decoding geometry. Both entry points export `CHUNKER_VERSION`;
the package root and `src/read.js` do not load the chunker.

| Field | Meaning |
| --- | --- |
| `text` | Selected source excerpt. |
| `embedText` | Embedding input with selected outline paths inserted at section boundaries. |
| `tokens` | Rounded, script-based estimate for the complete `embedText`; not a model token count. |
| `outlinePath` | Path at the first selected text; a chunk can cross sections. |
| `pageLabel` | First selected page's label, or a one-based PDF page ordinal. `null` when unavailable or for synthetic EPUB locations. |
| `sectionPart`, `sectionParts` | One-based passage number and total within a split group, which may combine short sections. |
| `auxiliary` | Whether the chunk belongs to a separate auxiliary group. |
| `positions` | Serializable source locations; `[]` if mapping fails. Present only with `getChunks`. |

See [text types](text.d.ts) and [position types](positions.d.ts) for the API.
The former `getNextChunk()` API is replaced by array iteration.

## Sizing

| Option | Meaning |
| --- | --- |
| `includeAuxiliary` | Include separate auxiliary chunks, such as captions and footnotes. Defaults to `false`; body chunks are unchanged. |
| `maxTokens` | Estimated `embedText` token ceiling, including context. Defaults to 768; integer ≥ 2. |
| `maxSize` | Alternative hard `embedText` ceiling in UTF-16 code units; integer ≥ 2. Cannot be combined with `maxTokens`. |
| `minSize` | Preferred source-text minimum in UTF-16 code units. `0` disables short-section grouping. |
| `overlap` | Maximum overlap in UTF-16 code units; paragraph-boundary splits do not overlap. |

Automatic defaults are approximately 120 tokens for the minimum and 48 for
overlap. Below `maxTokens: 768`, both scale down proportionally; at 64 tokens,
the minimum is approximately 10 tokens and overlap is 4. With `maxSize`, these
defaults are 120/768 and 48/768 of that character ceiling, rounded down.

```js
import { getTextChunks } from 'structured-document-text/src/chunker/text.js';

getChunks(structure, { maxTokens: 459 });
getTextChunks(structure, { maxSize: 3000, minSize: 450, overlap: 180 });
```

Explicit `minSize` and `overlap` must be nonnegative integers that fit the
calculated character budget (`minSize <= budget`, `overlap < budget`).
Invalid options throw `TypeError`. With automatic sizing, this budget depends
on the text; use `maxSize` when you need fixed character limits.

Heading context shares the budget with source text and may be omitted to leave
room for it. Token limits use a script-based heuristic, so consumers must still
enforce their model's actual token limit.

## Text selection

- Reference blocks and `flowClass: 'excluded'` blocks are omitted with their subtrees.
- Auxiliary blocks are omitted by default. Use `{ includeAuxiliary: true }` with
  either chunking entry point to include them. Classification is inherited through
  containers. Auxiliary groups stay separate from body text and other auxiliary
  roots. Within each outline section,
  body text stays together across auxiliary blocks.
- Short adjacent body sections accumulate into groups; a short trailing group joins
  the previous body group. Final chunks are ordered by their first selected source
  position, so split body and auxiliary passages can interleave.
- Complete headings directly targeted by the outline are replaced with context
  only when their titles match after whitespace normalization and the context fits.
  Other headings stay in the excerpt. Standalone headings are retained; matching
  headings whose body consists entirely of references are omitted.

Both entry points omit text without source anchors before sizing. PDF text nodes
need their own nonempty `textMap`; block maps and rectangles are not substitutes.
EPUB and snapshot text can use a containing element anchor for synthetic content,
such as an image description. Whitespace-only nodes need no anchor. Older PDF code
blocks without text-node maps need re-extraction to become indexable.

Splitting balances the remaining text across the estimated number of remaining
chunks, preferring paragraphs, sentences, whitespace, then code-point boundaries.
Overlap prefers whole sentences, then word boundaries, and may shorten for
progress. Sentence detection uses `Intl.Segmenter` with the `en` locale and can
vary with the runtime's Unicode rules.

Ordinary block edges are trimmed; in-block whitespace and preformatted indentation
are preserved. Blocks are separated by two newlines. Consecutive selected parts
linked by `nextPart` or `previousPart` join with a space, or a newline for code
when neither part supplies one. Tiny budgets can omit whitespace-only slices.

## Positions and recovery

A chunk's durable addresses are source-document positions, never SDT block
indexes, node paths or references to a particular extraction. Chunks can be
copied, serialized or transferred between workers.

- **PDF:** `{ pageIndex, rects }` per selected page, including middle pages.
  Character geometry is merged into line segments while keeping omissions,
  blocks, large gaps and writing directions separate. Existing `nextPageRects`
  is accepted on recovery and still means the immediately following page.
- **EPUB:** `FragmentSelector` CFI ranges, separated at omissions and content-file
  boundaries. Whole elements use CFIs without character offsets.
- **Snapshot:** body-relative `TextPositionSelector` ranges for source text,
  separated at omissions and source gaps. Synthetic content uses `CssSelector`
  element anchors. Recovery also accepts existing CSS selectors and refinements.

If a present anchor cannot be mapped, `getChunks()` keeps the text with
`positions: []`. Unsupported processors throw. Synthetic text may select an
entire element even when the chunk contains only part of its description.

`getPositionsText(structure, positions)` resolves saved positions against the
supplied SDT, orders and deduplicates the covered text, and applies the whitespace
rules above. It does not rerun chunking or exclusion policy. An empty position
array or an unresolved member returns `null`; gaps within a resolved selection
are tolerated. A valid whitespace-only DOM selection can return `""` after
ordinary-text trimming; preformatted whitespace is preserved.

Recovery can include surrounding text or change after re-extraction. EPUB offsets
are translated through `deltaMap` and clamped within the resolved text-node part
if it becomes shorter. Snapshot recovery accepts selections extending beyond
extracted coverage. Positions alone do not preserve the exact original excerpt
or embedding input.

### Snapshot text positions and HTML parsing

The snapshot extractor and the Reader's browser can build different element trees
from the same HTML. For example, the extractor's DOM map can contain `table > tr`,
while the browser inserts `tbody` and renders `table > tbody > tr`. A CSS selector
generated from the extractor's tree can therefore recover text correctly inside
SDT but match nothing in the Reader.

The chunker uses the existing body text stream for ordinary text positions instead
of generating CSS paths from that tree. Offsets are in original-source UTF-16 units;
`deltaMap` translates normalized SDT offsets back to that stream. Each disjoint
selected range gets its own position, so skipped headings, references and other
omissions are not pulled into a single broad range. Synthetic content such as an
image description has no body-text offsets and still selects its containing
element through a CSS anchor. Existing CSS positions remain readable.

This avoids tree-only differences such as an inserted `tbody`, without changing
the position shapes, chunk text, embedding input or SDT schema. It assumes the same
source file and body text order. Inserting text earlier in an edited HTML file
shifts body offsets; browser repairs that reorder text can also invalidate them.
Consumers must validate source identity. Synthetic element selectors remain
subject to differences between the extractor's and browser's trees.

For a broader future solution, document-worker's snapshot parser and DOM indexing
could follow browser HTML tree-construction rules, with text-stream accounting
consistent with the Reader. Before returning to element-relative text selectors,
test generated positions against the actual rendered source HTML, including
implicit table elements and malformed markup; SDT-only round trips cannot detect
this mismatch. Existing cached extractions would need the normal processor refresh
policy after such a producer change. Avoid table-specific selector rewrites in
the chunker: other browser tree repairs would remain unresolved.

## Integration limits

- Wholly synthetic EPUB elements need a Reader adapter to expand their CFIs to
  visible ranges; the current Reader resolves these to collapsed ranges.
- EPUB extraction can omit normalization offsets. The chunker tolerates shortened
  endpoints but cannot reconstruct missing shifts within text. Fixing those maps
  belongs in document-worker; see [recovery tests](../../test/chunker/epub-recovery.test.js).
- PDF recovery can include neighboring glyphs whose centers touch or overlap
  selected rectangles. This accepted limitation affects recovered text, not the
  original embedding input. Focused [recovery tests](../../test/chunker/pdf-recovery.test.js)
  cover overlapping and zero-width boundary glyphs.

Consumers own Reader navigation/highlighting, embedding storage, source validation
and refresh policy. Record chunking options with `CHUNKER_VERSION`, which versions
text selection, embedding formatting and defaults. Position-only fixes do not
change it; processor, schema and pack versions are separate. The chunker does not
run semantic search or regenerate embeddings.

## Development

`index.js` and `text.js` are the supported entry points; other files are private.
Text selection and splitting live in `chunks.js`/`split.js`; source mapping uses
a shared document index and one mapper per format.

Run `npm test` from the repository root with Node.js 24 or newer. Tests in
[test/chunker](../../test/chunker/) cover API behavior, text/position fixtures and
recovery exceptions.
