import { SessionTitle } from './records/sessionTitle'

export class SessionNumberView {
  static readonly numberCharactersConst = SessionTitle.numberCharactersConst

  static isSelectorNumber(value: string): boolean {
    return SessionTitle.isSelectorNumber(value)
  }
}
