import type { UpdateInfo } from "electron-updater";
import type { DtoAutoUpdateRelease } from "../common/autoUpdate.dto";

// The renderer shows release notes as a text node, so the GitHub HTML is reduced to text here
// instead of being rendered: no sanitizer dependency and no innerHTML in any consumer.
export class AutoUpdateReleaseNotes
{
  private static readonly entitiesConst: Readonly<Record<string, string>> =
    { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

  static toRelease(info: UpdateInfo): DtoAutoUpdateRelease
  {
    return {
      version: info.version,
      name: info.releaseName ?? null,
      date: info.releaseDate || null,
      notes: AutoUpdateReleaseNotes.toText(info.releaseNotes),
    };
  }

  static toText(notes: UpdateInfo["releaseNotes"]): string | null
  {
    if (notes === null || notes === undefined)
      return null;
    else if (typeof notes === "string")
      return AutoUpdateReleaseNotes.htmlToText(notes);
    else if (Array.isArray(notes))
      return notes.map(item => `${item.version}\n${AutoUpdateReleaseNotes.htmlToText(item.note ?? "") ?? ""}`).join("\n\n").trim() || null;
    else
      throw new Error("Unknown release notes shape");
  }

  private static htmlToText(html: string): string | null
  {
    const text = html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "\n- ")
      .replace(/<\/\s*(p|div|h[1-6]|ul|ol|pre|blockquote)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, entity => AutoUpdateReleaseNotes.entitiesConst[entity] ?? entity)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text || null;
  }
}
