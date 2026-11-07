/** One conversation of an agent, as its own store files it. */
export interface AgentConversation {
  /** Every id the record names: the confirmed one and an unverified one, without duplicates. */
  nativeSessionIds: readonly string[]
  /** The directory the agent was started in; Claude files the transcript under it. */
  cwd: string
  /** The session's creation: no child conversation of it started earlier. */
  since: number
}

/** What an erase did, in words a person reads. */
export interface ErasureReport {
  /** Each file, folder or store entry that went. */
  erased: string[]
  /** Each one that is still there, with the reason. */
  leftovers: string[]
  /** What the eraser cannot decide for the person, such as a memory file the conversation wrote. */
  notes: string[]
}

/** How one agent's own store forgets a conversation. Never throws: a failure is a leftover. */
export interface AgentHistoryEraser {
  erase(conversation: AgentConversation): Promise<ErasureReport>
}
