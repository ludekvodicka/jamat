import { createSocket } from 'node:dgram'

/** @param {string} mac @param {string} broadcast */
export function sendWakePacket(mac, broadcast) {
  const address = Buffer.from(mac.replaceAll(':', ''), 'hex')
  if (address.length !== 6)
    throw new Error('Expected a six-byte MAC address')
  const packet = Buffer.alloc(102, 0xff)
  for (let i = 0; i < 16; i++)
    address.copy(packet, 6 + i * 6)

  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    let finished = false
    const timer = setTimeout(() => finish(new Error('UDP send timed out')), 2000)
    /** @param {Error | null} error */
    function finish(error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(undefined)
    }
    socket.once('error', finish)
    socket.once('listening', () => {
      try {
        socket.setBroadcast(true)
        socket.send(packet, 9, broadcast, finish)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.bind()
  })
}
