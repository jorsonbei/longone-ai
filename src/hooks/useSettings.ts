import { useEffect, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../lib/AuthContext';
import { DEFAULT_NAMES_GLOSSARY_TEXT, DEFAULT_WUXING_CONFIG, WuxingConfig } from '../lib/wuxingKernel';

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
  const [wuxingConfig, setWuxingConfig] = useState<WuxingConfig>(() => {
    const saved = localStorage.getItem('wuxingConfig');
    if (!saved) return DEFAULT_WUXING_CONFIG;
    try {
      return {
        ...DEFAULT_WUXING_CONFIG,
        ...(JSON.parse(saved) as Partial<WuxingConfig>),
      };
    } catch {
      return DEFAULT_WUXING_CONFIG;
    }
  });
  const [settingsSyncState, setSettingsSyncState] = useState<'idle' | 'loading' | 'saving' | 'synced' | 'fallback-local'>('idle');
  const lastSyncedStateRef = useRef<string | null>(null);
  const hasLoadedRemoteRef = useRef(false);

  useEffect(() => {
    localStorage.setItem('systemInstruction', systemInstruction);
  }, [systemInstruction]);

  useEffect(() => {
    localStorage.setItem('wuxingConfig', JSON.stringify(wuxingConfig));
  }, [wuxingConfig]);

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
          const nextConfig: WuxingConfig = {
            responseMode: snapshot.data()?.responseMode || DEFAULT_WUXING_CONFIG.responseMode,
            enableNameParser: snapshot.data()?.enableNameParser ?? DEFAULT_WUXING_CONFIG.enableNameParser,
            enableLockDragonDiagnosis: snapshot.data()?.enableLockDragonDiagnosis ?? DEFAULT_WUXING_CONFIG.enableLockDragonDiagnosis,
            enableRecordProtocol: snapshot.data()?.enableRecordProtocol ?? DEFAULT_WUXING_CONFIG.enableRecordProtocol,
            showDiagnosticsSummary: false,
            namesGlossaryText: snapshot.data()?.namesGlossaryText || DEFAULT_NAMES_GLOSSARY_TEXT,
          };
          if (typeof remoteInstruction === 'string' && remoteInstruction.trim()) {
            setSystemInstruction((prev) => (prev === remoteInstruction ? prev : remoteInstruction));
          }
          setWuxingConfig((prev) => {
            const prevJson = JSON.stringify(prev);
            const nextJson = JSON.stringify(nextConfig);
            return prevJson === nextJson ? prev : nextConfig;
          });
          lastSyncedStateRef.current = JSON.stringify({
            systemInstruction: typeof remoteInstruction === 'string' && remoteInstruction.trim() ? remoteInstruction : systemInstruction,
            ...nextConfig,
          });
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
    const nextState = JSON.stringify({
      systemInstruction,
      ...wuxingConfig,
    });
    if (nextState === lastSyncedStateRef.current) return;

    setSettingsSyncState('saving');
    const timeoutId = window.setTimeout(async () => {
      try {
        const settingsRef = doc(db, 'workspaces', workspaceId, 'admin_settings', 'system');
        await setDoc(
          settingsRef,
          {
            systemInstruction,
            responseMode: wuxingConfig.responseMode,
            enableNameParser: wuxingConfig.enableNameParser,
            enableLockDragonDiagnosis: wuxingConfig.enableLockDragonDiagnosis,
            enableRecordProtocol: wuxingConfig.enableRecordProtocol,
            showDiagnosticsSummary: false,
            namesGlossaryText: wuxingConfig.namesGlossaryText,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
        lastSyncedStateRef.current = nextState;
        setSettingsSyncState('synced');
      } catch (error) {
        console.error('Failed to save system settings to Firestore:', error);
        setSettingsSyncState('fallback-local');
      }
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [systemInstruction, wuxingConfig, workspaceId, isAdmin]);

  const updateWuxingConfigField = <K extends keyof WuxingConfig>(field: K, value: WuxingConfig[K]) => {
    setWuxingConfig((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  return { systemInstruction, setSystemInstruction, settingsSyncState, wuxingConfig, updateWuxingConfigField };
}
