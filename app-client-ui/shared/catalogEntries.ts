/**
 * The two refusals every compile-time catalog in this client makes, in one place.
 *
 * Two entries sharing an **id** make whatever looks one up ambiguous - which tab is active, which
 * section a node belongs to, which flow a `flowId` names. Two sharing an **order** make the drawn
 * sequence depend on the sort's stability rather than on the catalog, which is a list that quietly
 * changes shape between runs.
 *
 * Written once because it had been written twice and was about to be written a third time, and
 * because the third catalog - the flows - refused neither, so its `order` decided nothing at all
 * while it held one entry.
 */
export class CatalogEntries {
  /** Both refusals over one flat catalog. */
  static assertDistinct(
    subject: string,
    entries: readonly { id: string; order: number }[],
  ): void {
    CatalogEntries.assertUnique(subject, 'id', entries.map((entry) => entry.id))
    CatalogEntries.assertUnique(subject, 'order', entries.map((entry) => entry.order))
  }

  /** One of them, for a catalog whose ids and orders are counted over different sets. */
  static assertUnique(
    subject: string,
    what: string,
    values: readonly (string | number)[],
  ): void {
    if (new Set(values).size !== values.length)
      throw new Error(`Two ${subject} claim the same ${what}: ${JSON.stringify(values)}`)
  }
}
