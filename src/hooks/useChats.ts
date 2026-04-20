import { useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/firebase';
import { collection, doc, query, orderBy, onSnapshot, setDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { ChatSession, Message } from '../types';
import { useAuth } from '../lib/AuthContext';
import { MODELS } from '../services/geminiService';

export function useChats() {
  const { workspaceId, user } = useAuth();
  
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [activeMessages, setActiveMessages] = useState<Message[]>([]);

  // Local state overlay for streaming messages to avoid Firestore writes on every token
  const [streamingMessages, setStreamingMessages] = useState<Message[]>([]);

  // Load conversations
  useEffect(() => {
    if (!workspaceId) {
      setIsLoaded(true);
      return;
    }

    const convRef = collection(db, 'workspaces', workspaceId, 'conversations');
    const q = query(convRef, orderBy('updatedAt', 'desc'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetched: ChatSession[] = snapshot.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messages: [] 
        };
      });
      
      setChats(fetched);
      setIsLoaded(true);
    });

    return () => unsubscribe();
  }, [workspaceId]);

  // Load messages for active chat
  useEffect(() => {
    if (!workspaceId || !activeChatId) {
      setActiveMessages([]);
      return;
    }

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

  const createNewChat = async () => {
    if (!workspaceId) return;
    const newId = uuidv4();
    const newChatRef = doc(db, 'workspaces', workspaceId, 'conversations', newId);
    await setDoc(newChatRef, {
      title: 'New Chat',
      model: MODELS.FLASH,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    setActiveChatId(newId);
  };

  const deleteChat = async (id: string) => {
    if (!workspaceId) return;
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
      status: 'completed',
      createdAt: msg.createdAt || Date.now()
    };
    if (msg.attachments) {
      payload.attachments = msg.attachments.map(att => {
        // Firestore document size limit is exactly 1MB. 
        // We drop inline `data` if it's over 700,000 characters to prevent crashes.
        // The data will be re-fetched from Firebase storage (`url`) if needed next time.
        if (att.data && att.data.length > 700000) {
           const { data, ...rest } = att;
           return rest;
        }
        return att;
      });
    }
    if (msg.citations) payload.citations = msg.citations;

    await setDoc(msgRef, payload);

    // Auto-rename if it's the first user message
    const chat = chats.find(c => c.id === chatId);
    if (chat && chat.title === 'New Chat' && msg.role === 'user' && titleHint) {
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

  const activeChatBase = chats.find(c => c.id === activeChatId) || null;
  // Combine cloud messages with active local streaming messages, ensuring no duplicate IDs
  const activeChat = activeChatBase ? { 
    ...activeChatBase, 
    messages: [
      ...activeMessages, 
      ...streamingMessages.filter(sm => !activeMessages.some(am => am.id === sm.id))
    ]
  } : null;

  return {
    chats,
    activeChat,
    activeChatId,
    setActiveChatId,
    createNewChat,
    deleteChat,
    renameChat,
    saveMessageToDb,
    updateStreamingMessages,
    isLoaded
  };
}
