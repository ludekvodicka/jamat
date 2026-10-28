export class ReviewActivationReceipts {
  static consume(identity: string, openId: string): boolean {
    const key = `commit-activation:${JSON.stringify([identity, openId])}`
    if (localStorage.getItem(key) !== null) return false
    localStorage.setItem(key, '1')
    return true
  }
}
