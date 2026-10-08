// Generate a unique session ID for pairing
// Uses cryptographically secure random bytes (session IDs guard access to the camera)

import * as Crypto from 'expo-crypto';

// Must have a length that divides 256 evenly, so `byte % length` is unbiased
const CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars; excluded similar-looking: I, O, 0, 1

export function generateSessionId(length: number = 6): string {
  const bytes = Crypto.getRandomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARACTERS[bytes[i] % CHARACTERS.length];
  }
  return result;
}

export function generateConnectionId(): string {
  return generateSessionId(12);
}

export function isValidConnectionId(connectionId: string): boolean {
  if (!connectionId || connectionId.length !== 12) {
    return false;
  }
  for (const char of connectionId) {
    if (!CHARACTERS.includes(char)) {
      return false;
    }
  }
  return true;
}

// Validate session ID format
export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length !== 6) {
    return false;
  }
  // Check if all characters are valid
  for (const char of sessionId) {
    if (!CHARACTERS.includes(char)) {
      return false;
    }
  }
  return true;
}
