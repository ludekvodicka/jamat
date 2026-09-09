/**
 * Where this package says something went wrong, and the ONE place that decides where that goes.
 *
 * The prefix and the sink were written out at every site - forty-eight of them across the three
 * programs - so "report this somewhere a person will actually see" was forty-eight edits rather
 * than one, and six of the six port fields that carry a report were the same line copied.
 *
 * The sink stays `console.error`: it is the established way this package reports, and it is for
 * whoever is debugging. A sentence written FOR the person who clicked is drawn on the surface they
 * clicked as well - `app/shared/detectionRefusal.ts` and the note the terminal panel draws are the
 * example - and that is a separate job from this one.
 */
export class AppClientUiReport {
  private static readonly prefixConst = '[app-client-ui]'

  static error(message: string): void {
    console.error(`${AppClientUiReport.prefixConst} ${message}`)
  }
}
