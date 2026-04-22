import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut } from 'firebase/auth';
import { auth } from './firebase';
import { ensureUserAndWorkspace } from './workspaceSetup';
import { AppRole, resolveAppRole } from './adminAccess';

interface AuthContextType {
  user: User | null;
  workspaceId: string | null;
  loading: boolean;
  authError: string | null;
  appRole: AppRole;
  isAdmin: boolean;
  signIn: () => Promise<void>;
  logOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  workspaceId: null,
  loading: true,
  authError: null,
  appRole: 'user',
  isAdmin: false,
  signIn: async () => {},
  logOut: async () => {},
});

export const AuthProvider: React.FC<{children: React.ReactNode}> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [appRole, setAppRole] = useState<AppRole>('user');

  useEffect(() => {
    let mounted = true;

    getRedirectResult(auth).catch((error: any) => {
      if (!mounted) return;
      console.error('Redirect sign-in failed:', error);
      if (error?.code === 'auth/unauthorized-domain') {
        setAuthError('当前域名未在 Firebase Auth 白名单中。注意：自 2025 年 4 月 28 日起，新项目不会自动允许 localhost。请在 Firebase Console -> Authentication -> Settings -> Authorized domains 中添加 localhost。');
        return;
      }

      setAuthError(error?.message || 'Google 登录失败，请稍后重试。');
    });

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!mounted) return;
      setUser(u);
      setAuthError(null);
      setAppRole(resolveAppRole(u?.email));

      if (u) {
        const wid = await ensureUserAndWorkspace(u);
        if (!mounted) return;
        setWorkspaceId(wid);
      } else {
        setWorkspaceId(null);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const signIn = async () => {
    try {
      setAuthError(null);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await signInWithPopup(auth, provider);
        return;
      } catch (error: any) {
        const popupFallbackCodes = new Set([
          'auth/popup-blocked',
          'auth/popup-closed-by-user',
          'auth/cancelled-popup-request',
          'auth/operation-not-supported-in-this-environment',
        ]);

        if (!popupFallbackCodes.has(error?.code)) {
          throw error;
        }
      }

      await signInWithRedirect(auth, provider);
    } catch (error: any) {
      console.error(error);
      if (error?.code === 'auth/unauthorized-domain') {
        setAuthError('当前域名未在 Firebase Auth 白名单中。请在 Firebase Console 中把 localhost 加入 Authorized domains。');
        return;
      }

      setAuthError(error?.message || 'Google 登录启动失败，请稍后重试。');
    }
  };

  const logOut = async () => {
    await signOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, workspaceId, loading, authError, appRole, isAdmin: appRole === 'admin', signIn, logOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
