import type { RemoteSessionInteraction } from '../remoteControl/remoteSessionViews'

export interface ReviewInteraction {
  ownerId: string
  actorId: string
  sessionId: string
}

export class ReviewInteractionAccess {
  private readonly admitted = new WeakMap<ReviewInteraction, () => boolean>()

  local(ownerId: string, sessionId: string, active: () => boolean): ReviewInteraction {
    return this.admit({ ownerId, actorId: `workspace:${ownerId}`, sessionId }, active)
  }

  peer(view: RemoteSessionInteraction, ownerId: string, active: () => boolean): ReviewInteraction {
    return this.admit({ ownerId, actorId: `peer:${view.peerId}`, sessionId: view.sessionId }, active)
  }

  isActive(interaction: ReviewInteraction): boolean { return this.admitted.get(interaction)?.() === true }

  private admit(interaction: ReviewInteraction, active: () => boolean): ReviewInteraction {
    const proof = Object.freeze(interaction)
    this.admitted.set(proof, active)
    return proof
  }
}
