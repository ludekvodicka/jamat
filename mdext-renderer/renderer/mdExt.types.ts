export interface MdExtRendererProps {
  source: string
  className?: string
  resolveImage(reference: string): Promise<string | null>
  onLink(reference: string): void
}
