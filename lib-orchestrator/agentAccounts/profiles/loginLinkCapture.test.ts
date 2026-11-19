import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoginLinkCapture } from './loginLinkCapture'

const link = 'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A65520%2Fcallback&scope=user%3Aprofile+user%3Ainference&state=a-b_c'

describe('LoginLinkCapture', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'jamat-login-link-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('names a script that stores the link it is opened with, & and % included', async () => {
    const environment = await LoginLinkCapture.prepare(home, 'BROWSER')
    const script = environment.BROWSER!
    expect(Object.keys(environment)).toEqual(['BROWSER'])
    // Claude Code quotes the URL when it starts the program BROWSER names, as the cmd line below does.
    const run = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${script}" "${link}""`], { windowsVerbatimArguments: true })
      : spawnSync('sh', [script, link])
    expect(run.status).toBe(0)
    expect(await LoginLinkCapture.read(home)).toBe(link)
  })

  it('reads nothing before the link arrives, after a new prepare, or when the file holds no https link', async () => {
    expect(await LoginLinkCapture.read(home)).toBeNull()
    const directory = join(home, LoginLinkCapture.directoryName)
    mkdirSync(directory)
    writeFileSync(join(directory, 'link.txt'), `"${link}"\r\n`)
    expect(await LoginLinkCapture.read(home)).toBe(link)
    await LoginLinkCapture.prepare(home, 'BROWSER')
    expect(await LoginLinkCapture.read(home)).toBeNull()
    for (const text of ['http://example.test/', 'https://example.test/ two words', 'ECHO is off.', `https://x.test/${'a'.repeat(LoginLinkCapture.linkLimit)}`]) {
      writeFileSync(join(directory, 'link.txt'), text)
      expect(await LoginLinkCapture.read(home)).toBeNull()
    }
  })
})
