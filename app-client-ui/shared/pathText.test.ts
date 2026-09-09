import { describe, expect, it } from 'vitest'

import { PathText } from './pathText'

/**
 * The window's one path comparison. There were three, and they disagreed about case: the file
 * viewer's lowercased only a path that starts with a drive letter, the library's lowercases on
 * win32, and the sessions tree's lowercased always - which calls two different files equal on a
 * case-sensitive filesystem.
 */
describe('app-client-ui/shared/pathText', () => {
  it('reads one directory written two Windows ways as one directory', () => {
    expect(PathText.equal('C:\\work\\app', 'c:/WORK/App')).toBe(true)
    expect(PathText.comparable('C:\\Work\\App\\')).toBe('c:/work/app')
  })

  it('keeps a POSIX path case-sensitive, because the filesystem is', () => {
    expect(PathText.equal('/home/me/Notes', '/home/me/notes')).toBe(false)
    expect(PathText.comparable('/home/me/Notes/')).toBe('/home/me/Notes')
  })

  it('does not care how a path ends', () => {
    expect(PathText.equal('C:/work/app', 'C:/work/app/')).toBe(true)
    expect(PathText.equal('/home/me/', '/home/me///')).toBe(true)
    expect(PathText.normalized('C:\\work\\app\\')).toBe('C:/work/app')
  })

  it('leaves the spelling alone where only the comparison is normalised', () => {
    // A category root is stored exactly as the user typed it; writing the normalised form back
    // would rewrite their config file every time something matched.
    expect(PathText.normalized('C:\\Work\\App')).toBe('C:/Work/App')
  })
})
