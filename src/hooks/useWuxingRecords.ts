import { useEffect, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, setDoc } from 'firebase/firestore';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/firebase';
import { WuxingDiagnosisSummary, WuxingRecord } from '../types';
import { useAuth } from '../lib/AuthContext';

export function useWuxingRecords() {
  const { workspaceId } = useAuth();
  const [records, setRecords] = useState<WuxingRecord[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setRecords([]);
      return;
    }

    const recordsRef = collection(db, 'workspaces', workspaceId, 'records');
    const q = query(recordsRef, orderBy('createdAt', 'desc'), limit(20));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      setRecords(
        snapshot.docs.map((entry) => ({
          id: entry.id,
          ...(entry.data() as Omit<WuxingRecord, 'id'>),
        })),
      );
    });

    return () => unsubscribe();
  }, [workspaceId]);

  const createRecord = async ({
    chatId,
    sourceMessageId,
    excerpt,
    diagnosis,
  }: {
    chatId: string;
    sourceMessageId: string;
    excerpt: string;
    diagnosis: WuxingDiagnosisSummary;
  }) => {
    if (!workspaceId) return null;

    const id = uuidv4();
    const category =
      diagnosis.names.length > 0
        ? 'name-insight'
        : diagnosis.lockDragon.state === 'locked' || diagnosis.lockDragon.state === 'releasing'
          ? 'lock-dragon'
          : 'new-light';
    const title =
      category === 'name-insight'
        ? `名字解析：${diagnosis.names.map((item) => item.name).join(' / ')}`
        : category === 'lock-dragon'
          ? '景龙锁记录'
          : '新光记录';

    await setDoc(doc(db, 'workspaces', workspaceId, 'records', id), {
      chatId,
      sourceMessageId,
      title,
      category,
      excerpt: excerpt.slice(0, 280),
      createdAt: Date.now(),
    });

    return id;
  };

  return {
    records,
    createRecord,
  };
}
