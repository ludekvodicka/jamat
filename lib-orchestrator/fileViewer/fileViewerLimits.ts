export class FileViewerLimits {
  static readonly sampleBytes = 64 * 1024
  static readonly chunkBytes = 64 * 1024
  static readonly fullTextBytes = 2 * 1024 * 1024
  /**
   * How much source may be syntax-highlighted, which is a question about the DRAWING THREAD, not
   * about how much a reader can carry.
   *
   * It was 1 MiB, the same order as the read limit, and Shiki's `codeToHtml` is one synchronous call
   * with no chunking and no yielding. Measured with the shipped configuration on 2026-08-24:
   * 1 048 608 bytes of plain TypeScript took **5 168 ms** and produced 9 MB of HTML - and one
   * renderer draws every panel of the window, so the terminal, the sessions tree and the tab bar all
   * stop for that long. Anything larger falls to a plain `<pre>`, which both callers already draw
   * when the highlighter refuses.
   */
  static readonly highlightBytes = 64 * 1024
  static readonly diagramSourceCharacters = 50_000

  /**
   * How many items one diagram may declare in all, refused BEFORE any layout validator runs.
   *
   * Every archify validator compares each PAIR of items to find overlapping boxes, which is
   * quadratic, and an item with no `pos` has NaN coordinates where the overlap test answers true -
   * so everything overlaps everything. About 4 000 ids fit under the character cap above and produce
   * roughly 8 million sentences, joined into ONE exception message and drawn into the DOM.
   */
  static readonly diagramItemsMax = 400

  /**
   * How much of a layout validator's complaint is drawn.
   *
   * The complaint is ONE exception message built by joining every problem found, and the
   * problems come from pair comparisons, so their number is quadratic in the item count above.
   * Bounded here as well, because the message goes into the DOM as text.
   */
  static readonly diagramProblemCharacters = 4_000

  /**
   * How long one diagram engine may take before the renderer stops waiting for it.
   *
   * Mermaid renders through a single static queue shared by every panel of the window, so a render
   * that never RETURNS - not one that rejects, which is handled - leaves every later diagram waiting
   * for the life of the process. The deadline frees the queue; the wedged render is still wedged.
   */
  static readonly diagramRenderMilliseconds = 15_000

  /**
   * How many fences in ONE document are syntax-highlighted, and how many diagrams are drawn.
   *
   * The per-call ceilings above bound one fence; nothing bounded how many. A generated API report
   * with 500 fences is 500 synchronous Shiki calls chained through the microtask queue with no
   * yield, on the thread that draws the terminal and the sessions tree as well. Past these, a fence
   * draws as plain text and a diagram offers its source.
   */
  static readonly highlightedFencesMax = 60
  static readonly diagramsMax = 30

  static readonly directoryEntries = 5_000

  /**
   * How many rows of hex are kept on screen at once, as a sliding window over the file.
   *
   * One row is 16 bytes and one chunk is 64 KiB, so this is four chunks. Without it every chunk was
   * appended to one growing array whose rows were ALL rebuilt on every press, and every row is a
   * `<span>` with no virtualisation: twenty presses over a large binary is 81 920 DOM nodes and
   * twenty rebuilds of everything before them.
   */
  static readonly hexRowsMax = 16_384

  /**
   * How many directory ENTRIES all live directory grants may hold between them.
   *
   * The count ceiling beside this one bounds grants, not size: 128 directories of up to 5 000 stored
   * entries each is 640 000 objects held in the main process, refreshed on every touch, long after
   * the panel that asked for them was closed. Every navigation mints a new grant without releasing
   * the old one, so an explorer walk reaches the count ceiling on its own.
   */
  static readonly directoryEntriesHeldMax = 50_000
}
