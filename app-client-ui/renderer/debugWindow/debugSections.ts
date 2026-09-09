import { CatalogEntries } from '../../shared/catalogEntries'
import type { DebugSectionId } from '../../shared/debugSections.types'
import type { DebugSectionDescriptor } from './debugSection.types'
import { HostConnectionSection } from './sections/host/hostConnectionSection'
import { HostDebugSection } from './sections/host/hostDebugSection'
import { HostLaunchSection } from './sections/host/hostLaunchSection'
import { HostRuntimesSection } from './sections/host/hostRuntimesSection'
import {
  RateClaudeSection,
  RateCodexSection,
  RateDebugSection,
} from './sections/rate/rateDebugSection'

/**
 * The one source of Debug nodes, read the way `ConfigurationTabs` reads its groups: whoever owns a
 * subsystem contributes a descriptor here and touches nothing else in the window.
 *
 * The set is known at compile time, so there is no registration at run time: a registry would add an
 * ordering problem between whoever registers and whoever draws, and buy nothing a literal cannot do.
 *
 * The tree is two levels because that is what the data is: a subsystem, and the parts of it somebody
 * goes looking for. A third level is a change to this file and to the walk below, not to the frame.
 */
export class DebugSections {
  private static readonly catalogConst: readonly DebugSectionDescriptor[] = [
    {
      id: 'host',
      title: 'Host',
      order: 0,
      Component: HostDebugSection,
      children: [
        { id: 'host-runtimes', title: 'Runtimes', order: 0, Component: HostRuntimesSection },
        { id: 'host-connection', title: 'Connection', order: 1, Component: HostConnectionSection },
        { id: 'host-launch', title: 'Launch', order: 2, Component: HostLaunchSection },
      ],
    },
    {
      id: 'rate',
      title: 'Rate limits',
      order: 1,
      Component: RateDebugSection,
      children: [
        { id: 'rate-codex', title: 'Codex', order: 0, Component: RateCodexSection },
        { id: 'rate-claude', title: 'Claude', order: 1, Component: RateClaudeSection },
      ],
    },
  ]

  /**
   * The tree the window draws, every level in `order`. The parameter defaults to the catalog and
   * exists so the two refusals below are checkable against a list that is allowed to be wrong;
   * nothing in the app passes it.
   *
   * An id must be unique across the WHOLE tree, because that is what the selection and the ping gate
   * carry; an order only among siblings, because that is all it decides.
   */
  static ordered(
    sections: readonly DebugSectionDescriptor[] = DebugSections.catalogConst,
  ): readonly DebugSectionDescriptor[] {
    CatalogEntries.assertUnique(
      'debug sections',
      'id',
      DebugSections.flatten(sections).map((node) => node.id),
    )
    return DebugSections.sortLevel(sections)
  }

  /** Every node of the tree, parents before their own children, in the order they are drawn. */
  static flatten(
    sections: readonly DebugSectionDescriptor[] = DebugSections.ordered(),
  ): readonly DebugSectionDescriptor[] {
    const flat: DebugSectionDescriptor[] = []
    for (const node of sections) {
      flat.push(node)
      flat.push(...DebugSections.flatten(node.children ?? []))
    }
    return flat
  }

  /** The node a selection names. An id the catalog does not hold is a defect, not an empty screen. */
  static nodeOf(
    id: DebugSectionId,
    sections: readonly DebugSectionDescriptor[] = DebugSections.ordered(),
  ): DebugSectionDescriptor {
    const found = DebugSections.flatten(sections).find((node) => node.id === id)
    if (!found)
      throw new Error(`The debug catalog holds no section ${JSON.stringify(id)}`)
    return found
  }

  private static sortLevel(
    sections: readonly DebugSectionDescriptor[],
  ): readonly DebugSectionDescriptor[] {
    CatalogEntries.assertUnique(
      'debug sections',
      'order',
      sections.map((section) => section.order),
    )
    return [...sections]
      .sort((left, right) => left.order - right.order)
      .map((section) => section.children === undefined
        ? section
        : { ...section, children: DebugSections.sortLevel(section.children) })
  }
}
