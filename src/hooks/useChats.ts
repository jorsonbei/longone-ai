import { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/firebase';
import { collection, doc, query, orderBy, onSnapshot, setDoc, deleteDoc, updateDoc, getCountFromServer, getDocs, writeBatch } from 'firebase/firestore';
import { ChatSession, Message } from '../types';
import { useAuth } from '../lib/AuthContext';
import { MODELS } from '../services/geminiService';
import { WUXING_ROOT_SEED_MESSAGE, WUXING_ROOT_SEED_MESSAGE_ID, WUXING_ROOT_SEED_VERSION } from '../lib/wuxingRootSeed';

const INLINE_ATTACHMENT_PERSIST_LIMIT = 850_000;
const ROOT_CHAT_TITLE = '物性论母会话';

function normalizeWuxingDiagnosis(input: any) {
  if (!input || typeof input !== 'object') return undefined;

  return {
    responseMode: input.responseMode || 'fusion',
    engines: Array.isArray(input.engines) ? input.engines : ['HFCD', 'Genesis'],
    lockDragon: {
      state: input.lockDragon?.state || 'not_applicable',
      signals: Array.isArray(input.lockDragon?.signals) ? input.lockDragon.signals : [],
      summary: input.lockDragon?.summary || '当前输入没有明显进入景龙锁语义区，默认按常规物性论问答处理。',
    },
    names: Array.isArray(input.names) ? input.names : [],
    canonHits: Array.isArray(input.canonHits) ? input.canonHits : [],
    canonRelations: Array.isArray(input.canonRelations) ? input.canonRelations : [],
    recordRecommended: Boolean(input.recordRecommended),
    protocolNote: input.protocolNote || '本轮回答可先完成问答，不强制落盘。',
    disableWebSearch: Boolean(input.disableWebSearch),
  };
}

export function useChats() {
  const { workspaceId, user } = useAuth();
  
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [activeMessages, setActiveMessages] = useState<Message[]>([]);
  const [rootChatId, setRootChatId] = useState<string | null>(null);
  const [rootMessages, setRootMessages] = useState<Message[]>([]);

  // Local state overlay for streaming messages to avoid Firestore writes on every token
  const [streamingMessages, setStreamingMessages] = useState<Message[]>([]);
  const createInFlightRef = useRef<Promise<string | null> | null>(null);
  const rootCreateInFlightRef = useRef<Promise<string | null> | null>(null);

  const syncRootSeedMessage = useCallback(async (chatId: string) => {
    if (!workspaceId) return;
    const seedMessageRef = doc(
      db,
      'workspaces',
      workspaceId,
      'conversations',
      chatId,
      'messages',
      WUXING_ROOT_SEED_MESSAGE_ID,
    );

    await setDoc(
      seedMessageRef,
      {
        role: 'model',
        content: WUXING_ROOT_SEED_MESSAGE,
        status: 'completed',
        seedVersion: WUXING_ROOT_SEED_VERSION,
      },
      { merge: true },
    );
  }, [workspaceId]);

  // Load conversations
  useEffect(() => {
    if (!workspaceId) {
      setIsLoaded(true);
      return;
    }

    const convRef = collection(db, 'workspaces', workspaceId, 'conversations');
    const q = query(convRef, orderBy('updatedAt', 'desc'));
    let cancelled = false;

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const fetched = await Promise.all(snapshot.docs.map(async (d) => {
        const data = d.data();
        const messagesRef = collection(db, 'workspaces', workspaceId, 'conversations', d.id, 'messages');
        const countSnapshot = await getCountFromServer(messagesRef);

        return {
          id: d.id,
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messages: [],
          messageCount: countSnapshot.data().count,
          parentChatId: data.parentChatId || null,
          rootChatId: data.rootChatId || null,
          isRoot: Boolean(data.isRoot),
          hiddenFromSidebar: Boolean(data.hiddenFromSidebar),
        } satisfies ChatSession;
      }));

      if (cancelled) return;
      const rootSession = fetched.find((chat) => chat.isRoot || chat.hiddenFromSidebar) || null;
      setRootChatId(rootSession?.id || null);
      setChats(fetched.filter((chat) => !(chat.isRoot || chat.hiddenFromSidebar)));
      setIsLoaded(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !rootChatId) {
      setRootMessages([]);
      return;
    }

    const messagesRef = collection(db, 'workspaces', workspaceId, 'conversations', rootChatId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          role: data.role as 'user' | 'model',
          content: data.content,
          status: data.status,
          createdAt: data.createdAt,
          citations: data.citations,
          attachments: data.attachments,
          replyToId: data.replyToId,
          wuxingDiagnosis: normalizeWuxingDiagnosis(data.wuxingDiagnosis),
        };
      });
      setRootMessages(msgs);
    });

    return () => unsubscribe();
  }, [workspaceId, rootChatId]);

  // Load messages for active chat
  useEffect(() => {
    if (!workspaceId || !activeChatId) {
      setActiveMessages([]);
      setStreamingMessages([]);
      return;
    }

    // Clear prior chat content immediately so switching/new-chat does not
    // briefly reuse the previous session's messages while Firestore catches up.
    setActiveMessages([]);
    setStreamingMessages([]);

    const messagesRef = collection(db, 'workspaces', workspaceId, 'conversations', activeChatId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'asc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          role: data.role as 'user' | 'model',
          content: data.content,
          status: data.status,
          createdAt: data.createdAt,
          citations: data.citations,
          attachments: data.attachments,
          replyToId: data.replyToId,
          wuxingDiagnosis: normalizeWuxingDiagnosis(data.wuxingDiagnosis),
        };
      });
      setActiveMessages(msgs);
    });

    return () => unsubscribe();
  }, [workspaceId, activeChatId]);

  // Auto-select first chat
  useEffect(() => {
    if (isLoaded && chats.length > 0 && !activeChatId) {
      setActiveChatId(chats[0].id);
    } else if (isLoaded && chats.length === 0 && !activeChatId) {
      // Auto-create chat if none
      createNewChat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, chats.length]);

  const ensureRootChat = async () => {
    if (!workspaceId) return null;
    if (rootChatId) return rootChatId;
    if (rootCreateInFlightRef.current) return rootCreateInFlightRef.current;

    const task = (async () => {
      const newRootId = uuidv4();
      const timestamp = Date.now();
      const rootRef = doc(db, 'workspaces', workspaceId, 'conversations', newRootId);
      await setDoc(rootRef, {
        title: ROOT_CHAT_TITLE,
        model: MODELS.PRO,
        status: 'active',
        messageCount: 1,
        isRoot: true,
        hiddenFromSidebar: true,
        rootChatId: newRootId,
        parentChatId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const seedMessageRef = doc(
        db,
        'workspaces',
        workspaceId,
        'conversations',
        newRootId,
        'messages',
        WUXING_ROOT_SEED_MESSAGE_ID,
      );
      await setDoc(seedMessageRef, {
        role: 'model',
        content: WUXING_ROOT_SEED_MESSAGE,
        status: 'completed',
        createdAt: timestamp,
        seedVersion: WUXING_ROOT_SEED_VERSION,
      });

      setRootChatId(newRootId);
      return newRootId;
    })();

    rootCreateInFlightRef.current = task;
    try {
      return await task;
    } finally {
      rootCreateInFlightRef.current = null;
    }
  };

  useEffect(() => {
    if (!isLoaded || !workspaceId || rootChatId) return;
    ensureRootChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, workspaceId, rootChatId, syncRootSeedMessage]);

  useEffect(() => {
    if (!workspaceId || !rootChatId) return;
    syncRootSeedMessage(rootChatId);
  }, [workspaceId, rootChatId, syncRootSeedMessage]);

  const createNewChat = async (initialTitle = 'New Chat') => {
    if (!workspaceId) return null;
    if (createInFlightRef.current) {
      return createInFlightRef.current;
    }

    const task = (async () => {
      const ensuredRootId = await ensureRootChat();
      const newId = uuidv4();
      const timestamp = Date.now();
      const newChatRef = doc(db, 'workspaces', workspaceId, 'conversations', newId);
      const optimisticChat: ChatSession = {
        id: newId,
        title: initialTitle,
        messages: [],
        messageCount: 0,
        rootChatId: ensuredRootId,
        parentChatId: ensuredRootId,
        isRoot: false,
        hiddenFromSidebar: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setStreamingMessages([]);
      setActiveMessages([]);
      setChats((prev) => {
        if (prev.some((chat) => chat.id === newId)) return prev;
        return [optimisticChat, ...prev];
      });
      setActiveChatId(newId);

      try {
        await setDoc(newChatRef, {
          title: initialTitle,
          model: MODELS.FLASH,
          status: 'active',
          messageCount: 0,
          rootChatId: ensuredRootId,
          parentChatId: ensuredRootId,
          isRoot: false,
          hiddenFromSidebar: false,
          createdAt: timestamp,
          updatedAt: timestamp
        });

        return newId;
      } catch (error) {
        setChats((prev) => prev.filter((chat) => chat.id !== newId));
        setActiveChatId((current) => (current === newId ? null : current));
        throw error;
      }
    })();

    createInFlightRef.current = task;
    try {
      return await task;
    } finally {
      createInFlightRef.current = null;
    }
  };

  const deleteChat = async (id: string) => {
    if (!workspaceId) return;
    const messagesRef = collection(db, 'workspaces', workspaceId, 'conversations', id, 'messages');
    const snapshot = await getDocs(messagesRef);

    if (!snapshot.empty) {
      const batch = writeBatch(db);
      snapshot.docs.forEach((messageDoc) => {
        batch.delete(messageDoc.ref);
      });
      await batch.commit();
    }

    await deleteDoc(doc(db, 'workspaces', workspaceId, 'conversations', id));
    if (activeChatId === id) {
       setActiveChatId(null);
    }
  };

  const renameChat = async (id: string, newTitle: string) => {
    if (!workspaceId) return;
    await updateDoc(doc(db, 'workspaces', workspaceId, 'conversations', id), {
      title: newTitle,
      updatedAt: Date.now()
    });
  };

  // Helper to persist a single message to Firestore
  const saveMessageToDb = async (chatId: string, msg: Message, titleHint?: string) => {
    if (!workspaceId) return;
    const msgRef = doc(db, 'workspaces', workspaceId, 'conversations', chatId, 'messages', msg.id);
    
    // Build payload conditionally to avoid undefined
    const payload: any = {
      role: msg.role,
      content: msg.content,
      status: msg.status || 'completed',
      createdAt: msg.createdAt || Date.now()
    };
    if (msg.attachments) {
      payload.attachments = msg.attachments.map(att => {
        // Firestore document size limit is exactly 1MB.
        // Keep moderately sized inline data so attachments still work even when
        // background storage upload is unavailable. Only drop very large payloads.
        // The data will be re-fetched from Firebase storage (`url`) if needed next time.
        if (att.data && att.data.length > INLINE_ATTACHMENT_PERSIST_LIMIT) {
           const { data, ...rest } = att;
           return rest;
        }
        return att;
      });
    }
    if (msg.citations) payload.citations = msg.citations;
    if (msg.replyToId) payload.replyToId = msg.replyToId;
    if (msg.wuxingDiagnosis) payload.wuxingDiagnosis = msg.wuxingDiagnosis;

    await setDoc(msgRef, payload);

    // Auto-rename if it's the first user message
    const chat = chats.find(c => c.id === chatId);
    if (chat && (chat.messageCount ?? 0) === 0 && msg.role === 'user' && titleHint) {
       await updateDoc(doc(db, 'workspaces', workspaceId, 'conversations', chatId), {
         title: titleHint.slice(0, 30) + (titleHint.length > 30 ? '...' : ''),
         updatedAt: Date.now()
       });
    } else {
       await updateDoc(doc(db, 'workspaces', workspaceId, 'conversations', chatId), {
         updatedAt: Date.now()
       });
    }
  };

  // Used by App.tsx to push local streams
  const updateStreamingMessages = useCallback((msgs: Message[]) => {
    setStreamingMessages(msgs);
  }, []);

  const activeChatBase = chats.find(c => c.id === activeChatId)
    || (activeChatId && (activeMessages.length > 0 || streamingMessages.length > 0)
      ? {
          id: activeChatId,
          title: '',
          messages: [],
          messageCount: activeMessages.length + streamingMessages.length,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      : null);
  const effectiveRootChatId = activeChatBase?.rootChatId || rootChatId;
  const inheritedRootMessages =
    effectiveRootChatId && effectiveRootChatId !== activeChatBase?.id
      ? rootMessages
      : [];
  // Combine cloud messages with active local streaming messages, ensuring no duplicate IDs
  const activeChat = activeChatBase ? { 
    ...activeChatBase, 
    messages: [
      ...activeMessages, 
      ...streamingMessages.filter(sm => !activeMessages.some(am => am.id === sm.id))
    ]
  } : null;
  const activePromptMessages = [
    ...inheritedRootMessages,
    ...(activeChat?.messages || []),
  ];

  return {
    chats,
    activeChat,
    activePromptMessages,
    activeChatId,
    rootChatId,
    setActiveChatId,
    createNewChat,
    deleteChat,
    renameChat,
    saveMessageToDb,
    updateStreamingMessages,
    isLoaded
  };
}
