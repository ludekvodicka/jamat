/**
 * `Promise.all` over a mapper, with a ceiling on how many run at once.
 *
 * It exists because `Promise.all(items.map(…))` reads as "do these" and means "start ALL of these
 * now". That is harmless over a handful of items and is not what this library does with it: one
 * file-changes listing fanned out to a hundred concurrent `git diff-tree` children and one status
 * pass to a `stat` per entry with no cap on the entries. Both run in the Electron main process,
 * which is also answering every other IPC call and holding the Host socket.
 *
 * Order is preserved, so a caller can keep indexing by position. The first rejection rejects the
 * whole call, exactly like `Promise.all`; work already started still finishes, which is why callers
 * that must not lose the rest catch per item instead.
 */
export class BoundedMap {
  static async run<TIn, TOut>(
    items: readonly TIn[],
    limit: number,
    mapper: (item: TIn, index: number) => Promise<TOut>,
  ): Promise<TOut[]> {
    if (limit < 1) throw new Error(`Bounded map needs a positive limit: ${limit}`)
    const results = new Array<TOut>(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        results[index] = await mapper(items[index], index)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    )
    return results
  }
}
