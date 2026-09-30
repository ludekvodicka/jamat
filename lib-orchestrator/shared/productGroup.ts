/**
 * A product group of `Q:/Projects`: a directory holding an empty file of this name holds the
 * product's projects, one per child directory
 * (`Q:/Tooling/agent_extensions/docs/architecture/applications-product-layout.md`).
 *
 * Only the checkpoint store reads it, and refuses to put a store over all of the group's projects.
 * The project manager does not: which directory the launcher unfolds is the category's Subfolders
 * setting (`flattenFolders`), so a group the setting does not name is listed as one project.
 */
export class ProductGroup {
  static readonly markerConst = '.appgroup'
}
