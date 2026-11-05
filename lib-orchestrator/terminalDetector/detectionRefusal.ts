/**
 * What a person is told when the terminal detection behind a menu item is no longer there.
 *
 * One sentence, written once. It existed four times in three wordings - "The terminal detection
 * behind this file", "The terminal detection behind this directory" and, in one place, "The
 * detection behind this directory" - which is a person reading two different answers to the same
 * thing depending on which service refused.
 *
 * It says what to DO, not only what happened, because there is something to do: the detection has a
 * time to live and clicking again re-runs it. A menu left open for two minutes is past it.
 */
export class DetectionRefusal {
  static detailOf(subject: 'file' | 'directory'): string {
    return `The terminal detection behind this ${subject} is gone; open it from the terminal again`
  }
}
