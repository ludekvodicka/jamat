import type { BrowserWindow, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiIpcInvokeMap, IpcResult } from '../../shared/appClientUiIpc'
import { ServiceDialogIpc } from './serviceDialogIpc'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  opened: [] as { parent: unknown; options: { title: string; properties: readonly string[] } }[],
  messageBoxes: [] as { parent: unknown; options: Record<string, unknown> }[],
  directoryAnswer: { canceled: true, filePaths: [] as string[] },
  messageAnswer: { response: 1 },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    },
  },
  dialog: {
    showOpenDialog: (
      parent: unknown,
      options: { title: string; properties: readonly string[] },
    ) => {
      electronMock.opened.push({ parent, options })
      return Promise.resolve(electronMock.directoryAnswer)
    },
    showMessageBox: (...args: unknown[]) => {
      const parent = args.length === 1 ? null : args[0]
      const options = args.at(-1) as Record<string, unknown>
      electronMock.messageBoxes.push({ parent, options })
      return Promise.resolve(electronMock.messageAnswer)
    },
  },
}))

describe('app-client-ui/app/shell/serviceDialogIpc', () => {
  const windowConst = { id: 1 } as unknown as BrowserWindow
  const holderWindowConst = { id: 2 } as unknown as BrowserWindow
  const mainSender = { id: 11 } as unknown as WebContents
  const holderSender = { id: 12 } as unknown as WebContents
  const unknownSender = { id: 13 } as unknown as WebContents
  let service: ServiceDialogIpc

  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.opened.length = 0
    electronMock.messageBoxes.length = 0
    electronMock.directoryAnswer = { canceled: true, filePaths: [] }
    electronMock.messageAnswer = { response: 1 }
    service = new ServiceDialogIpc((sender) =>
      sender === holderSender ? holderWindowConst : windowConst)
  })

  async function pick(
    title: string,
    sender: WebContents = mainSender,
  ): Promise<IpcResult<{ path: string } | null>> {
    const channel: keyof AppClientUiIpcInvokeMap = 'dialog:pick-directory'
    const handler = electronMock.handlers.get(channel)
    if (!handler)
      throw new Error(`No handler for ${channel}`)
    return handler({ sender }, title) as Promise<IpcResult<{ path: string } | null>>
  }

  it('registers a handler for every channel it declares', () => {
    service.initialize()
    expect([...electronMock.handlers.keys()].sort())
      .toEqual(Object.keys(ServiceDialogIpc.channelsConst).sort())
  })

  it('fails the boot when one of its channels has no handler', () => {
    const internals = service as unknown as {
      assertComplete(channels: typeof ServiceDialogIpc.channelsConst): void
    }
    expect(() => internals.assertComplete(ServiceDialogIpc.channelsConst))
      .toThrow(/IPC channel is not registered/)
  })

  it('answers a cancelled dialog with nothing picked', async () => {
    service.initialize()

    expect(await pick('Choose a projects root')).toEqual({ ok: true, value: null })
  })

  it('answers a chosen directory with its path', async () => {
    electronMock.directoryAnswer = { canceled: false, filePaths: ['C:/Projects/NodeJs'] }
    service.initialize()

    expect(await pick('Choose a projects root'))
      .toEqual({ ok: true, value: { path: 'C:/Projects/NodeJs' } })
  })

  // A cancel on some platforms comes back as "not cancelled, nothing selected"; both are the same
  // answer to a caller that asked for one directory.
  it('answers an empty selection with nothing picked', async () => {
    electronMock.directoryAnswer = { canceled: false, filePaths: [] }
    service.initialize()

    expect(await pick('Choose a projects root')).toEqual({ ok: true, value: null })
  })

  it('opens a directory picker parented to the window, carrying the title it was given', async () => {
    electronMock.directoryAnswer = { canceled: false, filePaths: ['C:/Projects/Web'] }
    service.initialize()

    await pick('Choose a projects root')

    expect(electronMock.opened).toEqual([{
      parent: windowConst,
      options: { title: 'Choose a projects root', properties: ['openDirectory'] },
    }])
  })

  it('parents to the renderer window and falls back to main for an unknown sender', async () => {
    service.initialize()

    await pick('From holder', holderSender)
    await pick('From unknown', unknownSender)

    expect(electronMock.opened.map((opened) => opened.parent))
      .toEqual([holderWindowConst, windowConst])
  })

  // The renderer cannot ask without a window, so this is a broken main process rather than a user
  // action - and it must reach the caller as a failed result, not as an unparented dialog nobody
  // can see.
  it('refuses to open a picker with no window to open it over', async () => {
    const orphan = new ServiceDialogIpc(() => null)
    orphan.initialize()

    const answer = await pick('Choose a projects root')

    expect(answer.ok).toBe(false)
    if (!answer.ok)
      expect(answer.error).toMatch(/no window/)
    expect(electronMock.opened).toEqual([])
  })

  async function confirm(
    message: string,
    detail: string,
    sender: WebContents = mainSender,
  ): Promise<IpcResult<boolean>> {
    const channel: keyof AppClientUiIpcInvokeMap = 'dialog:confirm'
    const handler = electronMock.handlers.get(channel)
    if (!handler)
      throw new Error(`No handler for ${channel}`)
    return handler({ sender }, message, detail) as Promise<IpcResult<boolean>>
  }

  it('answers a question yes only through the first button', async () => {
    electronMock.messageAnswer = { response: 0 }
    service.initialize()

    expect(await confirm('Restart this session?', 'The running process will be stopped.'))
      .toEqual({ ok: true, value: true })
    expect(electronMock.messageBoxes).toEqual([{
      parent: windowConst,
      options: {
        type: 'question',
        message: 'Restart this session?',
        detail: 'The running process will be stopped.',
        buttons: ['Yes', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      },
    }])
  })

  it('answers no for anything else, which is what Escape and the close button land on', async () => {
    service.initialize()

    expect(await confirm('Restart this session?', 'detail')).toEqual({ ok: true, value: false })
  })

  it('parents the question to the window that asked it', async () => {
    service.initialize()

    await confirm('From holder', 'detail', holderSender)

    expect(electronMock.messageBoxes.map((box) => box.parent)).toEqual([holderWindowConst])
  })

  /**
   * Unlike the picker, which refuses: a question with no window is still worth asking, because the
   * alternative answer is silence where somebody is waiting for a yes or a no.
   */
  it('asks without a parent rather than refusing when the window has gone', async () => {
    const orphan = new ServiceDialogIpc(() => null)
    orphan.initialize()

    expect(await confirm('Restart this session?', 'detail')).toEqual({ ok: true, value: false })
    expect(electronMock.messageBoxes.map((box) => box.parent)).toEqual([null])
  })

  it('confirms closing the main window only through the destructive button', async () => {
    electronMock.messageAnswer = { response: 0 }

    expect(await service.confirmMainWindowClose(windowConst, 1)).toBe(true)

    expect(electronMock.messageBoxes).toEqual([{
      parent: windowConst,
      options: {
        type: 'warning',
        message: 'This is the main window',
        detail: 'Closing it also closes 1 other window.',
        buttons: ['Close All Windows', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      },
    }])
  })

  it('treats Cancel as refusal and can show the warning without a parent', async () => {
    expect(await service.confirmMainWindowClose(null, 3)).toBe(false)

    expect(electronMock.messageBoxes).toEqual([{
      parent: null,
      options: expect.objectContaining({
        detail: 'Closing it also closes 3 other windows.',
      }),
    }])
  })

  /**
   * The unsolicited one, and the only dialog here whose default is its SECOND button: anyone who can
   * reach the peer port can raise it, so Enter, Escape and the close button all have to land on
   * Deny. The display name is the caller's own text, which is why it is quoted inside a sentence
   * this build wrote.
   */
  it('asks whether to let an unknown caller in, showing its address and defaulting to Deny',
    async () => {
      expect(await service.confirmInboundAccess(windowConst, {
        remoteComputerId: 'computer-remote',
        remoteEndpointId: 'endpoint-remote',
        displayName: 'Studio',
        fingerprint: 'fp-remote',
        remoteAddress: '203.0.113.20',
      })).toBe(false)

      expect(electronMock.messageBoxes).toEqual([{
        parent: windowConst,
        options: {
          type: 'warning',
          message: 'Let "Studio" control this computer?',
          detail: 'Computer: computer-remote\nEndpoint: endpoint-remote\nFingerprint: fp-remote\n'
            + 'Calling from: 203.0.113.20\n\n'
            + 'Check the fingerprint against the one shown on that computer. '
            + 'If you were not expecting this, click Deny.',
          buttons: ['Allow', 'Deny'],
          defaultId: 1,
          cancelId: 1,
        },
      }])
      const options = electronMock.messageBoxes[0]?.options
      expect(options?.defaultId).toBe(1)
      expect(options?.cancelId).toBe(1)
    })

  it('grants inbound access only through the Allow button', async () => {
    electronMock.messageAnswer = { response: 0 }

    expect(await service.confirmInboundAccess(null, {
      remoteComputerId: 'computer-remote',
      remoteEndpointId: 'endpoint-remote',
      displayName: 'Studio',
      fingerprint: 'fp-remote',
      remoteAddress: '203.0.113.20',
    })).toBe(true)
  })

  /**
   * The two inputs differ in exactly one way that matters, and it is the one the dialog has to say:
   * a pasted bundle carried the key before anything was dialled, a typed address pins whatever
   * answered at it.
   */
  it('words the pairing question by where the key came from', async () => {
    const request = {
      remoteComputerId: 'computer-remote',
      remoteEndpointId: 'endpoint-remote',
      displayName: 'Studio',
      fingerprint: 'fp-remote',
    }

    expect(await service.confirmPairing(windowConst, { ...request, source: 'bundle' })).toBe(false)
    expect(await service.confirmPairing(windowConst, { ...request, source: 'address' })).toBe(false)

    expect(electronMock.messageBoxes.map((box) => box.options)).toEqual([
      {
        type: 'warning',
        message: 'Pair with "Studio"?',
        detail: 'Computer: computer-remote\nEndpoint: endpoint-remote\nFingerprint: fp-remote\n\n'
          + 'Check the fingerprint against the one shown on that computer.\n\n'
          + 'Its key came with the pasted bundle, pinned before the first connection.',
        buttons: ['Pair', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      },
      {
        type: 'warning',
        message: 'Pair with "Studio"?',
        detail: 'Computer: computer-remote\nEndpoint: endpoint-remote\nFingerprint: fp-remote\n\n'
          + 'Check the fingerprint against the one shown on that computer.\n\n'
          + 'Its key was fetched from the address you typed. Compare the fingerprint with the one '
          + 'shown on that computer before you continue.',
        buttons: ['Pair', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      },
    ])
  })
})
