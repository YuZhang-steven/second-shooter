// Mock for firebase/firestore
export const doc = jest.fn((db, collection, id) => ({
  id,
  path: `${collection}/${id}`,
}));

export const setDoc = jest.fn().mockResolvedValue(undefined);
export const getDoc = jest.fn().mockResolvedValue({
  exists: () => true,
  data: () => ({}),
});
export const deleteDoc = jest.fn().mockResolvedValue(undefined);

export const collection = jest.fn((db, ...pathSegments) => ({
  path: pathSegments.join('/'),
}));

export const addDoc = jest.fn().mockResolvedValue({ id: 'mock-doc-id' });

export const onSnapshot = jest.fn((ref, callback) => {
  // Return unsubscribe function
  return jest.fn();
});

export const serverTimestamp = jest.fn(() => ({ _serverTimestamp: true }));
export const deleteField = jest.fn(() => ({ _deleteField: true }));

export const Timestamp = {
  fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
};

export type Unsubscribe = () => void;
export type DocumentReference = { id: string; path: string };
export type CollectionReference = { path: string };
