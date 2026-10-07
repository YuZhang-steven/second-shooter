import { useState, useCallback, useEffect, useRef } from 'react';
import { signalingService } from '../services/SignalingService';
import { SignalingOffer, SignalingAnswer, IceCandidate } from '../types';
import { Unsubscribe } from 'firebase/firestore';

type Role = 'camera' | 'remote';

interface UseSignalingReturn {
  sessionId: string | null;
  isConnected: boolean;
  error: string | null;
  createSession: (preferredSessionId?: string) => Promise<string>;
  joinSession: (sessionId: string) => Promise<boolean>;
  sendOffer: (offer: SignalingOffer) => Promise<void>;
  sendAnswer: (answer: SignalingAnswer) => Promise<void>;
  addIceCandidate: (candidate: IceCandidate) => Promise<void>;
  onOffer: (callback: (offer: SignalingOffer) => void) => void;
  onAnswer: (callback: (answer: SignalingAnswer) => void) => void;
  onIceCandidate: (callback: (candidate: IceCandidate) => void) => void;
  cleanup: () => void;
}

export function useSignaling(role: Role): UseSignalingReturn {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unsubscribersRef = useRef<Unsubscribe[]>([]);
  const sessionIdRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    // Unsubscribe from all listeners
    unsubscribersRef.current.forEach((unsub) => unsub());
    unsubscribersRef.current = [];

    // Cleanup signaling service
    signalingService.cleanup();

    sessionIdRef.current = null;
    setSessionId(null);
    setIsConnected(false);
    setError(null);
  }, []);

  // Create a new session (camera device)
  const createSession = useCallback(async (preferredSessionId?: string): Promise<string> => {
    try {
      setError(null);
      const id = await signalingService.createSession(preferredSessionId);
      sessionIdRef.current = id;
      setSessionId(id);
      return id;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      setError(message);
      throw err;
    }
  }, []);

  // Join an existing session (remote device)
  const joinSession = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      const success = await signalingService.joinSession(id);

      if (success) {
        sessionIdRef.current = id;
        setSessionId(id);
        return true;
      } else {
        setError('Session not found');
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join session';
      setError(message);
      throw err;
    }
  }, []);

  // Send WebRTC offer
  const sendOffer = useCallback(async (offer: SignalingOffer): Promise<void> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      throw new Error('No active session');
    }

    try {
      await signalingService.sendOffer(currentSessionId, offer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send offer';
      setError(message);
      throw err;
    }
  }, []);

  // Send WebRTC answer
  const sendAnswer = useCallback(async (answer: SignalingAnswer): Promise<void> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      throw new Error('No active session');
    }

    try {
      await signalingService.sendAnswer(currentSessionId, answer);
      setIsConnected(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send answer';
      setError(message);
      throw err;
    }
  }, []);

  // Add ICE candidate
  const addIceCandidate = useCallback(async (candidate: IceCandidate): Promise<void> => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      throw new Error('No active session');
    }

    try {
      // Role determines which subcollection to use
      const candidateRole = role === 'camera' ? 'offer' : 'answer';
      await signalingService.addIceCandidate(currentSessionId, candidate, candidateRole);
    } catch (err) {
      console.error('Failed to add ICE candidate:', err);
      // Don't throw - ICE candidate failures are often recoverable
    }
  }, [role]);

  // Listen for offer (remote device listens)
  const onOffer = useCallback((callback: (offer: SignalingOffer) => void): void => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      console.error('No active session');
      return;
    }

    const unsubscribe = signalingService.onOffer(currentSessionId, callback);
    unsubscribersRef.current.push(unsubscribe);
  }, []);

  // Listen for answer (camera device listens)
  const onAnswer = useCallback((callback: (answer: SignalingAnswer) => void): void => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      console.error('No active session');
      return;
    }

    const unsubscribe = signalingService.onAnswer(currentSessionId, (answer) => {
      setIsConnected(true);
      callback(answer);
    });
    unsubscribersRef.current.push(unsubscribe);
  }, []);

  // Listen for ICE candidates
  const onIceCandidate = useCallback((callback: (candidate: IceCandidate) => void): void => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      console.error('No active session');
      return;
    }

    // Camera listens for answer candidates, remote listens for offer candidates
    const candidateRole = role === 'camera' ? 'answer' : 'offer';
    const unsubscribe = signalingService.onIceCandidate(currentSessionId, candidateRole, callback);
    unsubscribersRef.current.push(unsubscribe);
  }, [role]);

  return {
    sessionId,
    isConnected,
    error,
    createSession,
    joinSession,
    sendOffer,
    sendAnswer,
    addIceCandidate,
    onOffer,
    onAnswer,
    onIceCandidate,
    cleanup,
  };
}

export default useSignaling;
