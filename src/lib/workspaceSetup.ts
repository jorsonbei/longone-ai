import { db } from './firebase';
import { doc, getDoc, setDoc, query, collection, where, getDocs } from 'firebase/firestore';
import { User } from 'firebase/auth';

export async function ensureUserAndWorkspace(user: User): Promise<string | null> {
  if (!user || !user.uid) return null;

  try {
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      // Create user
      await setDoc(userRef, {
        email: user.email || '',
        createdAt: Date.now(),
        status: 'active'
      });
      console.log('User profile created in Firestore');
    }

    // Find or create default workspace
    const wsQuery = query(collection(db, 'workspaces'), where('ownerId', '==', user.uid));
    const wsSnap = await getDocs(wsQuery);

    if (wsSnap.empty) {
      // Create default workspace
      // Using a custom ID approach or just a random doc ID. Let's use a random doc reference.
      const newWsRef = doc(collection(db, 'workspaces'));
      await setDoc(newWsRef, {
        ownerId: user.uid,
        name: 'Personal Workspace',
        planType: 'free',
        createdAt: Date.now()
      });
      return newWsRef.id;
    } else {
      return wsSnap.docs[0].id;
    }
  } catch (error) {
    console.error("Error setting up user/workspace:", error);
    return null;
  }
}
