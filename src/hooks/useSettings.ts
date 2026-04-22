import { useEffect, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/AuthContext';

const DEFAULT_PERSONA = `默认偏好：
- 简单问候、测试消息或确认句先自然短答，不要过度解读。
- 真正进入分析时，先给结论，再展开结构。
- 除非我明确要求，否则避免过长、过重的理论铺垫。

你也可以在这里补充自己的表达偏好。`;

export function useSettings() {
  const { workspaceId, isAdmin } = useAuth();
  const [systemInstruction, setSystemInstruction] = useState<string>(() => {
    return localStorage.getItem('systemInstruction') || DEFAULT_PERSONA;
  });
  const [settingsSyncState, setSettingsSyncState] = useState<'idle' | 'loading' | 'saving' | 'synced' | 'fallback-local'>('idle');
  const lastSyncedInstructionRef = useRef<string | null>(null);
  const hasLoadedRemoteRef = useRef(false);

  useEffect(() => {
    localStorage.setItem('systemInstruction', systemInstruction);
  }, [systemInstruction]);

  useEffect(() => {
    if (!workspaceId || !isAdmin) {
      setSettingsSyncState('fallback-local');
      hasLoadedRemoteRef.current = false;
      return;
    }

    setSettingsSyncState('loading');
    const settingsRef = doc(db, 'workspaces', workspaceId, 'admin_settings', 'system');
    const unsubscribe = onSnapshot(
      settingsRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const remoteInstruction = snapshot.data()?.systemInstruction;
          if (typeof remoteInstruction === 'string' && remoteInstruction.trim()) {
            lastSyncedInstructionRef.current = remoteInstruction;
            setSystemInstruction((prev) => (prev === remoteInstruction ? prev : remoteInstruction));
          }
        }

        hasLoadedRemoteRef.current = true;
        setSettingsSyncState('synced');
      },
      (error) => {
        console.error('Failed to load system settings from Firestore:', error);
        hasLoadedRemoteRef.current = true;
        setSettingsSyncState('fallback-local');
      }
    );

    return () => unsubscribe();
  }, [workspaceId, isAdmin]);

  useEffect(() => {
    if (!workspaceId || !isAdmin || !hasLoadedRemoteRef.current) return;
    if (systemInstruction === lastSyncedInstructionRef.current) return;

    setSettingsSyncState('saving');
    const timeoutId = window.setTimeout(async () => {
      try {
        const settingsRef = doc(db, 'workspaces', workspaceId, 'admin_settings', 'system');
        await setDoc(
          settingsRef,
          {
            systemInstruction,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
        lastSyncedInstructionRef.current = systemInstruction;
        setSettingsSyncState('synced');
      } catch (error) {
        console.error('Failed to save system settings to Firestore:', error);
        setSettingsSyncState('fallback-local');
      }
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [systemInstruction, workspaceId, isAdmin]);

  return { systemInstruction, setSystemInstruction, settingsSyncState };
}
