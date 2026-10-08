import {
  generateSessionId,
  generateConnectionId,
  isValidSessionId,
  isValidConnectionId,
} from '../../utils/sessionId';

describe('sessionId utilities', () => {
  describe('generateSessionId', () => {
    it('should generate a 6-character session ID by default', () => {
      const sessionId = generateSessionId();
      expect(sessionId).toHaveLength(6);
    });

    it('should generate session ID with custom length', () => {
      const sessionId = generateSessionId(8);
      expect(sessionId).toHaveLength(8);
    });

    it('should only contain valid characters (no I, O, 0, 1)', () => {
      const invalidChars = ['I', 'O', '0', '1'];

      // Generate multiple IDs to increase chance of catching invalid chars
      for (let i = 0; i < 100; i++) {
        const sessionId = generateSessionId();
        for (const char of sessionId) {
          expect(invalidChars).not.toContain(char);
        }
      }
    });

    it('should only contain uppercase letters and digits', () => {
      const validPattern = /^[A-HJ-NP-Z2-9]+$/;

      for (let i = 0; i < 50; i++) {
        const sessionId = generateSessionId();
        expect(sessionId).toMatch(validPattern);
      }
    });

    it('should generate unique session IDs', () => {
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        ids.add(generateSessionId());
      }

      // With 31^6 possible combinations, collisions in 100 tries are extremely unlikely
      expect(ids.size).toBe(100);
    });
  });

  describe('connection generation IDs', () => {
    it('generates valid 12-character IDs', () => {
      const connectionId = generateConnectionId();
      expect(connectionId).toHaveLength(12);
      expect(isValidConnectionId(connectionId)).toBe(true);
    });

    it('rejects wrong-length or excluded-character connection IDs', () => {
      expect(isValidConnectionId('ABC234')).toBe(false);
      expect(isValidConnectionId('ABC234XYZ78I')).toBe(false);
    });
  });

  describe('isValidSessionId', () => {
    it('should return true for valid 6-character session ID', () => {
      expect(isValidSessionId('ABC234')).toBe(true);
      expect(isValidSessionId('XYZPQR')).toBe(true);
      expect(isValidSessionId('999999')).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(isValidSessionId('')).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isValidSessionId(null as unknown as string)).toBe(false);
      expect(isValidSessionId(undefined as unknown as string)).toBe(false);
    });

    it('should return false for wrong length', () => {
      expect(isValidSessionId('ABC23')).toBe(false);  // 5 chars
      expect(isValidSessionId('ABC2345')).toBe(false);  // 7 chars
      expect(isValidSessionId('AB')).toBe(false);  // 2 chars
    });

    it('should return false for IDs containing excluded characters', () => {
      expect(isValidSessionId('ABC12I')).toBe(false);  // Contains I
      expect(isValidSessionId('ABC12O')).toBe(false);  // Contains O
      expect(isValidSessionId('ABC120')).toBe(false);  // Contains 0
      expect(isValidSessionId('ABC121')).toBe(false);  // Contains 1
    });

    it('should return false for lowercase letters', () => {
      expect(isValidSessionId('abc234')).toBe(false);
      expect(isValidSessionId('ABc234')).toBe(false);
    });

    it('should return false for special characters', () => {
      expect(isValidSessionId('ABC23!')).toBe(false);
      expect(isValidSessionId('ABC-23')).toBe(false);
      expect(isValidSessionId('ABC 23')).toBe(false);
    });

    it('should validate generated session IDs', () => {
      for (let i = 0; i < 50; i++) {
        const sessionId = generateSessionId();
        expect(isValidSessionId(sessionId)).toBe(true);
      }
    });
  });
});
