import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  addDoc,
  onSnapshot,
  serverTimestamp,
  deleteField,
  Timestamp,
  Unsubscribe,
  DocumentReference,
  CollectionReference,
} from 'firebase/firestore';
import {
  db,
  ensureSignedIn,
  SESSIONS_COLLECTION,
  OFFER_CANDIDATES_SUBCOLLECTION,
  ANSWER_CANDIDATES_SUBCOLLECTION,
} from '../config/firebase';
import { generateSessionId, isValidSessionId } from '../utils/sessionId';
import { SignalingOffer, SignalingAnswer, IceCandidate } from '../types';

// Signaling documents are still temporary, but an active camera can refresh
// or recreate its session after a long outage. The rules cap each individual
// expiry at <2 hours, so recovery extends the lease rather than storing a
// far-future timestamp.
const SESSION_TTL_MS = 60 * 60 * 1000;

function sessionExpireAt(): Timestamp {
  return Timestamp.fromMillis(Date.now() + SESSION_TTL_MS);
}

type IceCandidateCallback = (candidate: IceCandidate) => void;
type OfferCallback = (offer: SignalingOffer) => void;
type AnswerCallback = (answer: SignalingAnswer) => void;

class SignalingService {
  private sessionId: string | null = null;
  private ownsSession = false;
  private unsubscribers: Unsubscribe[] = [];
  private processedOfferSdp: string | null = null;
  private processedAnswerSdp: string | null = null;

  /**
   * A recording can outlive the signaling document. Firestore TTL may delete
   * the session while both phones are offline, but the camera keeps the same
   * 6-character ID in memory. When connectivity returns, recreate that exact
   * session so the same QR/link can attach a controller again.
   */
  private async ensureOwnedSessionDocument(sessionId: string): Promise<void> {
    if (!this.ownsSession || this.sessionId !== sessionId) {
      return;
    }

    await ensureSignedIn();

    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);
    const snapshot = await getDoc(sessionRef);

    if (!snapshot.exists()) {
      console.log(`[Signaling] Recreating expired session ${sessionId}`);
      await setDoc(sessionRef, {
        createdAt: serverTimestamp(),
        expireAt: sessionExpireAt(),
        status: 'waiting',
      });

      // A recreated session must accept fresh descriptions from whichever
      // controller joins next.
      this.processedAnswerSdp = null;
    }
  }


  // Create a signaling session. A remembered camera can provide its
  // previous 6-character Pair ID so controller and camera never have to scan
  // again. The Firestore document remains temporary; the Pair ID is the durable
  // identity stored locally on both phones.
  async createSession(preferredSessionId?: string): Promise<string> {
    await ensureSignedIn();

    // Reset processed flags for new/restored session
    this.processedOfferSdp = null;
    this.processedAnswerSdp = null;

    const normalizedPreferred = preferredSessionId?.trim().toUpperCase();
    const sessionId =
      normalizedPreferred && isValidSessionId(normalizedPreferred)
        ? normalizedPreferred
        : generateSessionId();

    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);
    const existing = await getDoc(sessionRef);

    if (existing.exists()) {
      // A force-quit can leave the old signaling document behind. Preserve its
      // original createdAt (required by Firestore rules), but remove stale SDP
      // so a remembered controller never answers an offer from a previous app
      // process before the fresh offer is published.
      await setDoc(
        sessionRef,
        {
          expireAt: sessionExpireAt(),
          status: 'waiting',
          offer: deleteField(),
          answer: deleteField(),
        },
        { merge: true }
      );
    } else {
      await setDoc(sessionRef, {
        createdAt: serverTimestamp(),
        expireAt: sessionExpireAt(),
        status: 'waiting',
      });
    }

    this.sessionId = sessionId;
    this.ownsSession = true;
    return sessionId;
  }

  // Join an existing session
  async joinSession(sessionId: string): Promise<boolean> {
    await ensureSignedIn();

    // Reset processed flags for new session
    this.processedOfferSdp = null;
    this.processedAnswerSdp = null;

    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);
    const sessionDoc = await getDoc(sessionRef);

    if (!sessionDoc.exists()) {
      return false;
    }

    this.sessionId = sessionId;
    this.ownsSession = false;
    return true;
  }

  // Send WebRTC offer
  async sendOffer(sessionId: string, offer: SignalingOffer): Promise<void> {
    // Recovery is allowed even if Firestore TTL removed the old pairing doc
    // during a long offline recording.
    await this.ensureOwnedSessionDocument(sessionId);

    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);
    await setDoc(
      sessionRef,
      {
        offer: {
          type: offer.type,
          sdp: offer.sdp,
        },
        status: 'offer_sent',
        // Extend the lease every time the camera advertises/re-advertises.
        expireAt: sessionExpireAt(),
      },
      { merge: true }
    );
  }

  // Send WebRTC answer
  async sendAnswer(sessionId: string, answer: SignalingAnswer): Promise<void> {
    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);
    await setDoc(
      sessionRef,
      {
        answer: {
          type: answer.type,
          sdp: answer.sdp,
        },
        status: 'connected',
        expireAt: sessionExpireAt(),
      },
      { merge: true }
    );
  }

  // Listen for offer
  onOffer(sessionId: string, callback: OfferCallback): Unsubscribe {
    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);

    const unsubscribe = onSnapshot(sessionRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.offer && data.offer.sdp !== this.processedOfferSdp) {
        // Mark this offer as processed to avoid duplicate handling
        this.processedOfferSdp = data.offer.sdp;
        callback({
          type: data.offer.type,
          sdp: data.offer.sdp,
        });
      }
    });

    this.unsubscribers.push(unsubscribe);
    return unsubscribe;
  }

  // Listen for answer
  onAnswer(sessionId: string, callback: AnswerCallback): Unsubscribe {
    const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);

    const unsubscribe = onSnapshot(sessionRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.answer && data.answer.sdp !== this.processedAnswerSdp) {
        // Mark this answer as processed to avoid duplicate handling
        this.processedAnswerSdp = data.answer.sdp;
        callback({
          type: data.answer.type,
          sdp: data.answer.sdp,
        });
      }
    });

    this.unsubscribers.push(unsubscribe);
    return unsubscribe;
  }

  // Add ICE candidate
  async addIceCandidate(
    sessionId: string,
    candidate: IceCandidate,
    role: 'offer' | 'answer'
  ): Promise<void> {
    const subcollection =
      role === 'offer'
        ? OFFER_CANDIDATES_SUBCOLLECTION
        : ANSWER_CANDIDATES_SUBCOLLECTION;

    const candidatesRef = collection(
      db,
      SESSIONS_COLLECTION,
      sessionId,
      subcollection
    );

    await addDoc(candidatesRef, {
      candidate: candidate.candidate,
      sdpMLineIndex: candidate.sdpMLineIndex,
      sdpMid: candidate.sdpMid,
      expireAt: sessionExpireAt(),
    });
  }

  // Listen for ICE candidates
  onIceCandidate(
    sessionId: string,
    role: 'offer' | 'answer',
    callback: IceCandidateCallback
  ): Unsubscribe {
    const subcollection =
      role === 'offer'
        ? OFFER_CANDIDATES_SUBCOLLECTION
        : ANSWER_CANDIDATES_SUBCOLLECTION;

    const candidatesRef = collection(
      db,
      SESSIONS_COLLECTION,
      sessionId,
      subcollection
    );

    const unsubscribe = onSnapshot(candidatesRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          callback({
            candidate: data.candidate,
            sdpMLineIndex: data.sdpMLineIndex,
            sdpMid: data.sdpMid,
          });
        }
      });
    });

    this.unsubscribers.push(unsubscribe);
    return unsubscribe;
  }

  // Delete session and cleanup
  async deleteSession(sessionId: string): Promise<void> {
    try {
      // Only the main session document is deleted here; candidate subcollection
      // docs (and abandoned sessions) are garbage-collected by the Firestore
      // TTL policies on their expireAt fields.
      const sessionRef = doc(db, SESSIONS_COLLECTION, sessionId);
      await deleteDoc(sessionRef);
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  }

  // Cleanup all listeners
  cleanup(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];

    if (this.sessionId && this.ownsSession) {
      this.deleteSession(this.sessionId);
    }
    this.sessionId = null;
    this.ownsSession = false;

    // Reset processed flags for next session
    this.processedOfferSdp = null;
    this.processedAnswerSdp = null;
  }

  // Get current session ID
  getSessionId(): string | null {
    return this.sessionId;
  }
}

// Export singleton instance
export const signalingService = new SignalingService();
export default signalingService;
