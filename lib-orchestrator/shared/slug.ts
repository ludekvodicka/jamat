/**
 * A name as a directory, a branch or a config key can carry it: lowercase ASCII, every run of
 * anything else one hyphen, no hyphen at either end.
 *
 * **Accents are FOLDED rather than dropped**, so `Zákazníci` becomes `zakaznici` and not
 * `z-kazn-ci`. That decision was made once, for the category ids the projects settings writes, and
 * the two rules written the same day for branch and directory names kept dropping - three slug
 * functions, one of them right, and nothing anywhere recording whether the difference was meant.
 * There is one rule now, and this comment is the record.
 *
 * What it does NOT decide is what an empty result means, because the two callers disagree for good
 * reasons: a category must have an id, so the settings tab falls back to `root`; a worktree must not
 * be given an invented name, so the launcher reads empty as "not enough to name it after" and
 * refuses isolation.
 *
 * Web-safe by design and with no imports of its own: the launcher draws what a name WILL become
 * before anything is created, and a preview of a transformation the other side performs has to be
 * the same transformation (`CLAUDE.md` rule 1).
 */
export class Slug {
  static of(value: string): string {
    return value.normalize('NFD')
      .replace(/[^\x20-\x7e]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }
}
