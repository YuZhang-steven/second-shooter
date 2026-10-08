import { signalingService } from '../../services/SignalingService';
import * as firestore from 'firebase/firestore';
import { generateSessionId } from '../../utils/sessionId';

// Mock the sessionId generator
jest.mock('../../utils/sessionId', () => ({
  generateSessionId: jest.fn(() => 'ABC123'),
  isValidSessionId: jest.fn((value: string) => /^[A-HJ-NP-Z2-9]{6}$/.test(value)),
  isValidConnectionId: jest.fn((value: string) => /^[A-HJ-NP-Z2-9]{12}$/.test(value)),
}));

// Get mock functions
const mockSetDoc = firestore.setDoc as jest.Mock;
const mockGetDoc = firestore.getDoc as jest.Mock;
const mockDeleteDoc = firestore.deleteDoc as jest.Mock;
const mockAddDoc = firestore.addDoc as jest.Mock;
const mockOnSnapshot = firestore.onSnapshot as jest.Mock;
const mockDoc = firestore.doc as jest.Mock;
const mockCollection = firestore.collection as jest.Mock;

describe('SignalingService', () => {
  beforeEach(() => {
    // Reset service state
    signalingService.cleanup();
    jest.clearAllMocks();

    // Reset default mock implementations
    mockGetDoc.mockResolvedValue({
      exists: () => false,
      data: () => null,
    });
    mockSetDoc.mockResolvedValue(undefined);
    mockAddDoc.mockResolvedValue({ id: 'mock-doc-id' });
    mockOnSnapshot.mockReturnValue(jest.fn()); // Returns unsubscribe function
  });

  describe('createSession', () => {
    it('should create a new session and return session ID', async () => {
      const sessionId = await signalingService.createSession();

      expect(sessionId).toBe('ABC123');
      expect(generateSessionId).toHaveBeenCalled();
    });

    it('should set session document with initial data', async () => {
      await signalingService.createSession();

      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: 'waiting',
        })
      );
    });

    it('should store session ID internally', async () => {
      await signalingService.createSession();

      expect(signalingService.getSessionId()).toBe('ABC123');
    });

    it('should restore a remembered Pair ID without generating a new one', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ status: 'connected' }),
      });

      const sessionId = await signalingService.createSession('XYZ789');

      expect(sessionId).toBe('XYZ789');
      expect(generateSessionId).not.toHaveBeenCalled();
      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: 'waiting',
          offer: expect.anything(),
          answer: expect.anything(),
        }),
        { merge: true }
      );
    });
  });

  describe('joinSession', () => {
    it('should return true for existing session', async () => {
      mockGetDoc.mockResolvedValue({
        exists: () => true,
        data: () => ({ status: 'waiting' }),
      });

      const result = await signalingService.joinSession('XYZ789');

      expect(result).toBe(true);
    });

    it('should return false for non-existing session', async () => {
      mockGetDoc.mockResolvedValue({
        exists: () => false,
        data: () => null,
      });

      const result = await signalingService.joinSession('NONEXISTENT');

      expect(result).toBe(false);
    });

    it('should store session ID when joining successfully', async () => {
      mockGetDoc.mockResolvedValue({
        exists: () => true,
        data: () => ({}),
      });

      await signalingService.joinSession('XYZ789');

      expect(signalingService.getSessionId()).toBe('XYZ789');
    });

    it('should not store session ID when session does not exist', async () => {
      mockGetDoc.mockResolvedValue({
        exists: () => false,
      });

      await signalingService.joinSession('NONEXISTENT');

      expect(signalingService.getSessionId()).toBeNull();
    });
  });

  describe('remembered-controller reconnect handshake', () => {
    it('clears stale SDP and writes a fresh connection generation', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ status: 'connected' }),
      });
      await signalingService.joinSession('XYZ789');

      await signalingService.requestReconnect('XYZ789', 'ABC234XYZ789');

      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          connectionId: 'ABC234XYZ789',
          status: 'waiting',
          offer: expect.anything(),
          answer: expect.anything(),
        }),
        { merge: true }
      );
    });

    it('delivers only a fresh reconnect generation once to the camera', async () => {
      let snapshotCallback: (snapshot: { data: () => any }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const callback = jest.fn();
      signalingService.onReconnectRequest('ABC123', callback);

      snapshotCallback!({
        data: () => ({
          connectionId: 'ABC234XYZ789',
        }),
      });
      snapshotCallback!({
        data: () => ({
          connectionId: 'ABC234XYZ789',
        }),
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('ABC234XYZ789');
    });

    it('ignores stale offers from a different controller generation', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ status: 'waiting' }),
      });
      await signalingService.joinSession('XYZ789');
      await signalingService.requestReconnect('XYZ789', 'ABC234XYZ789');

      let snapshotCallback: (snapshot: { data: () => any }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const offerCallback = jest.fn();
      signalingService.onOffer('XYZ789', offerCallback);

      snapshotCallback!({
        data: () => ({
          connectionId: 'ZZZ234YYY789',
          offer: { type: 'offer', sdp: 'stale-offer' },
        }),
      });
      snapshotCallback!({
        data: () => ({
          connectionId: 'ABC234XYZ789',
          offer: { type: 'offer', sdp: 'fresh-offer' },
        }),
      });

      expect(offerCallback).toHaveBeenCalledTimes(1);
      expect(offerCallback).toHaveBeenCalledWith({
        type: 'offer',
        sdp: 'fresh-offer',
      });
    });
  });

  describe('sendOffer', () => {
    it('should send offer to session document', async () => {
      const offer = { type: 'offer' as const, sdp: 'mock-offer-sdp' };

      await signalingService.sendOffer('ABC123', offer);

      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          offer: {
            type: 'offer',
            sdp: 'mock-offer-sdp',
          },
          status: 'offer_sent',
        }),
        { merge: true }
      );
    });
  });

  describe('long-outage recovery', () => {
    it('recreates an expired owned session with the same ID before publishing a new offer', async () => {
      await signalingService.createSession();
      mockSetDoc.mockClear();

      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
        data: () => null,
      });

      await signalingService.sendOffer('ABC123', {
        type: 'offer',
        sdp: 'recovery-offer',
      });

      expect(mockSetDoc).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          status: 'waiting',
        })
      );
      expect(mockSetDoc).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          offer: { type: 'offer', sdp: 'recovery-offer' },
          status: 'offer_sent',
          expireAt: expect.anything(),
        }),
        { merge: true }
      );
    });
  });

  describe('sendAnswer', () => {
    it('should send answer to session document', async () => {
      const answer = { type: 'answer' as const, sdp: 'mock-answer-sdp' };

      await signalingService.sendAnswer('ABC123', answer);

      expect(mockSetDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          answer: {
            type: 'answer',
            sdp: 'mock-answer-sdp',
          },
          status: 'connected',
        }),
        { merge: true }
      );
    });
  });

  describe('onOffer', () => {
    it('should set up snapshot listener', () => {
      signalingService.onOffer('ABC123', jest.fn());

      expect(mockOnSnapshot).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const mockUnsubscribe = jest.fn();
      mockOnSnapshot.mockReturnValue(mockUnsubscribe);

      const unsubscribe = signalingService.onOffer('ABC123', jest.fn());

      expect(unsubscribe).toBe(mockUnsubscribe);
    });

    it('should call callback with offer data when present', () => {
      let snapshotCallback: (snapshot: { data: () => unknown }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const offerCallback = jest.fn();
      signalingService.onOffer('ABC123', offerCallback);

      // Simulate snapshot with offer
      snapshotCallback!({
        data: () => ({
          offer: { type: 'offer', sdp: 'test-sdp' },
        }),
      });

      expect(offerCallback).toHaveBeenCalledWith({
        type: 'offer',
        sdp: 'test-sdp',
      });
    });

    it('should not call callback when no offer present', () => {
      let snapshotCallback: (snapshot: { data: () => unknown }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const offerCallback = jest.fn();
      signalingService.onOffer('ABC123', offerCallback);

      // Simulate snapshot without offer
      snapshotCallback!({
        data: () => ({ status: 'waiting' }),
      });

      expect(offerCallback).not.toHaveBeenCalled();
    });

    it('should not process same offer twice (deduplication)', () => {
      let snapshotCallback: (snapshot: { data: () => unknown }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const offerCallback = jest.fn();
      signalingService.onOffer('ABC123', offerCallback);

      const offerData = { offer: { type: 'offer', sdp: 'same-sdp' } };

      // Simulate same snapshot twice
      snapshotCallback!({ data: () => offerData });
      snapshotCallback!({ data: () => offerData });

      expect(offerCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAnswer', () => {
    it('should call callback with answer data when present', () => {
      let snapshotCallback: (snapshot: { data: () => unknown }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const answerCallback = jest.fn();
      signalingService.onAnswer('ABC123', answerCallback);

      // Simulate snapshot with answer
      snapshotCallback!({
        data: () => ({
          answer: { type: 'answer', sdp: 'test-answer-sdp' },
        }),
      });

      expect(answerCallback).toHaveBeenCalledWith({
        type: 'answer',
        sdp: 'test-answer-sdp',
      });
    });

    it('should not process same answer twice (deduplication)', () => {
      let snapshotCallback: (snapshot: { data: () => unknown }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const answerCallback = jest.fn();
      signalingService.onAnswer('ABC123', answerCallback);

      const answerData = { answer: { type: 'answer', sdp: 'same-answer-sdp' } };

      // Simulate same snapshot twice
      snapshotCallback!({ data: () => answerData });
      snapshotCallback!({ data: () => answerData });

      expect(answerCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('addIceCandidate', () => {
    it('should add candidate to offerCandidates for offer role', async () => {
      const candidate = {
        candidate: 'candidate:123',
        sdpMLineIndex: 0,
        sdpMid: 'audio',
      };

      await signalingService.addIceCandidate('ABC123', candidate, 'offer');

      expect(mockCollection).toHaveBeenCalledWith(
        expect.anything(),
        'sessions',
        'ABC123',
        'offerCandidates'
      );
      expect(mockAddDoc).toHaveBeenCalled();
    });

    it('should add candidate to answerCandidates for answer role', async () => {
      const candidate = {
        candidate: 'candidate:456',
        sdpMLineIndex: 1,
        sdpMid: 'video',
      };

      await signalingService.addIceCandidate('ABC123', candidate, 'answer');

      expect(mockCollection).toHaveBeenCalledWith(
        expect.anything(),
        'sessions',
        'ABC123',
        'answerCandidates'
      );
      expect(mockAddDoc).toHaveBeenCalled();
    });
  });

  describe('onIceCandidate', () => {
    it('should listen to correct subcollection based on role', () => {
      signalingService.onIceCandidate('ABC123', 'offer', jest.fn());

      expect(mockCollection).toHaveBeenCalledWith(
        expect.anything(),
        'sessions',
        'ABC123',
        'offerCandidates'
      );
    });

    it('should call callback for added documents', () => {
      let snapshotCallback: (snapshot: { docChanges: () => unknown[] }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const candidateCallback = jest.fn();
      signalingService.onIceCandidate('ABC123', 'offer', candidateCallback);

      // Simulate document added
      snapshotCallback!({
        docChanges: () => [
          {
            type: 'added',
            doc: {
              data: () => ({
                candidate: 'candidate:789',
                sdpMLineIndex: 0,
                sdpMid: 'audio',
              }),
            },
          },
        ],
      });

      expect(candidateCallback).toHaveBeenCalledWith({
        candidate: 'candidate:789',
        sdpMLineIndex: 0,
        sdpMid: 'audio',
      });
    });

    it('should not call callback for modified documents', () => {
      let snapshotCallback: (snapshot: { docChanges: () => unknown[] }) => void;
      mockOnSnapshot.mockImplementation((ref, callback) => {
        snapshotCallback = callback;
        return jest.fn();
      });

      const candidateCallback = jest.fn();
      signalingService.onIceCandidate('ABC123', 'offer', candidateCallback);

      // Simulate document modified (not added)
      snapshotCallback!({
        docChanges: () => [
          {
            type: 'modified',
            doc: {
              data: () => ({
                candidate: 'candidate:789',
                sdpMLineIndex: 0,
                sdpMid: 'audio',
              }),
            },
          },
        ],
      });

      expect(candidateCallback).not.toHaveBeenCalled();
    });
  });

  describe('deleteSession', () => {
    it('should delete session document', async () => {
      await signalingService.deleteSession('ABC123');

      expect(mockDeleteDoc).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockDeleteDoc.mockRejectedValue(new Error('Delete failed'));

      // Should not throw
      await expect(signalingService.deleteSession('ABC123')).resolves.not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should unsubscribe all listeners', () => {
      const mockUnsubscribe1 = jest.fn();
      const mockUnsubscribe2 = jest.fn();

      mockOnSnapshot
        .mockReturnValueOnce(mockUnsubscribe1)
        .mockReturnValueOnce(mockUnsubscribe2);

      signalingService.onOffer('ABC123', jest.fn());
      signalingService.onAnswer('ABC123', jest.fn());

      signalingService.cleanup();

      expect(mockUnsubscribe1).toHaveBeenCalled();
      expect(mockUnsubscribe2).toHaveBeenCalled();
    });

    it('should delete current session', async () => {
      await signalingService.createSession();

      signalingService.cleanup();

      expect(mockDeleteDoc).toHaveBeenCalled();
    });

    it('should not delete joined sessions during cleanup', async () => {
      await signalingService.joinSession('XYZ789');

      signalingService.cleanup();

      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('should reset session ID', async () => {
      await signalingService.createSession();
      expect(signalingService.getSessionId()).toBe('ABC123');

      signalingService.cleanup();

      expect(signalingService.getSessionId()).toBeNull();
    });
  });

  describe('getSessionId', () => {
    it('should return null initially', () => {
      expect(signalingService.getSessionId()).toBeNull();
    });

    it('should return session ID after creating session', async () => {
      await signalingService.createSession();

      expect(signalingService.getSessionId()).toBe('ABC123');
    });
  });
});
