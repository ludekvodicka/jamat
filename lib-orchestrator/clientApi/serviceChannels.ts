type MergedChannels<T extends readonly unknown[]> =
  T extends readonly [infer Head, ...infer Rest] ? Head & MergedChannels<Rest> : unknown

export class ServiceChannels {
  static merge<T extends readonly Record<string, true>[]>(tables: T): MergedChannels<T> {
    const merged: Record<string, true> = {}
    for (const table of tables)
      for (const channel of Object.keys(table)) {
        if (channel in merged)
          throw new Error(`Two IPC services claim the same channel: ${channel}`)
        merged[channel] = true
      }
    return merged as MergedChannels<T>
  }
}
