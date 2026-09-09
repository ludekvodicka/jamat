import { describe, expect, it } from 'vitest'

import { TabTransferDrag, type TabTransferData } from './tabTransfer'

class TransferData implements TabTransferData {
  private readonly values = new Map<string, string>()

  get types(): readonly string[] {
    return [...this.values.keys()]
  }

  getData(format: string): string {
    return this.values.get(format) ?? ''
  }

  setData(format: string, data: string): void {
    this.values.set(format, data)
  }
}

describe('app-client-ui/shared/tabTransfer', () => {
  it('writes and reads the custom MIME token before its text fallback', () => {
    const data = new TransferData()

    TabTransferDrag.write(data, 'token-1')
    data.setData('text/plain', 'jamat-tab:other')

    expect(data.types).toEqual(['application/x-jamat-tab', 'text/plain'])
    expect(TabTransferDrag.tokenOf(data)).toBe('token-1')
  })

  it('reads only an exact non-empty text marker when custom MIME is unavailable', () => {
    const data = new TransferData()
    data.setData('text/plain', 'jamat-tab:token-1')
    expect(TabTransferDrag.tokenOf(data)).toBe('token-1')

    data.setData('text/plain', 'token-1')
    expect(TabTransferDrag.tokenOf(data)).toBeNull()
    data.setData('text/plain', 'jamat-tab:')
    expect(TabTransferDrag.tokenOf(data)).toBeNull()
  })

  it('recognizes only the two transfer types during dragover', () => {
    const data = new TransferData()
    expect(TabTransferDrag.mayContainToken(null)).toBe(false)
    expect(TabTransferDrag.mayContainToken(data)).toBe(false)

    data.setData('text/plain', '')
    expect(TabTransferDrag.mayContainToken(data)).toBe(true)
  })
})
