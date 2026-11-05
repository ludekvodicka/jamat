export interface MdExtRendererProps {
  source: string
  className?: string
  resolveImage(reference: string): Promise<string | null>
  onLink(reference: string): void
  interaction?: MdExtInteraction
}

export interface MdExtInteraction {
  enabled: boolean
  toggleTask(line: number, checked: boolean): void
  askAbout?(line: number): void
}
