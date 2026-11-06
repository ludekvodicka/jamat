import { writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

import type { FileViewerExportFormat } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import type { DocumentPdfPrinter } from './documentPdfPrinter'

/**
 * A document written beside its source: `notes.md` gives `notes.html` or `notes.pdf`. An earlier
 * export of the same name is replaced, because generating again is how it is brought up to date.
 */
export class DocumentExport {
  /** The renderer's Markdown limit is 2 MiB; its HTML with inline styles stays well inside this. */
  static readonly htmlBytesMaxConst = 32 * 1024 * 1024
  private readonly printer: Pick<DocumentPdfPrinter, 'print'>

  constructor(printer: Pick<DocumentPdfPrinter, 'print'>) {
    this.printer = printer
  }

  static target(source: string, format: FileViewerExportFormat): string {
    const target = join(dirname(source), `${parse(source).name}.${format}`)
    if (resolve(target).toLowerCase() === resolve(source).toLowerCase())
      throw new Error(`The document is itself a .${format} file`)
    return target
  }

  /** The path written. */
  async write(source: string, format: FileViewerExportFormat, html: string): Promise<string> {
    if (Buffer.byteLength(html) > DocumentExport.htmlBytesMaxConst)
      throw new Error('The generated document is too large')
    const target = DocumentExport.target(source, format)
    if (format === 'html') await writeFile(target, html, 'utf8')
    else if (format === 'pdf') await writeFile(target, await this.printer.print(html))
    else throw new Error(`Unknown export format: ${JSON.stringify(format)}`)
    return target
  }
}
