export interface CommitProgress {
  stage: 'preparing' | 'sending' | 'transmitting' | 'committing' | 'verifying'
  completed: number
  total: number | null
}
