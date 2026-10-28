export class CliVersion {
  static parse(text: string): string {
    const version = /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(text.trim())?.[1]
    if (!version) throw new Error(`Unrecognized CLI version: ${text.slice(0, 120)}`)
    return version
  }

  static newerRelease(release: string, installed: string): boolean {
    if (!/^\d+\.\d+\.\d+$/.test(release)) throw new Error(`Expected a stable release version, received ${release}`)
    const current = CliVersion.parse(installed)
    const targetParts = release.split('.').map(Number)
    const currentParts = current.split('-')[0].split('.').map(Number)
    for (let i = 0; i < 3; i++)
      if (targetParts[i] !== currentParts[i]) return targetParts[i] > currentParts[i]
    return current.includes('-')
  }
}
