import type { ResponseMode } from './lib/wuxingKernel';
import type { CanonEntry, CanonRelation } from './lib/wuxingCanon';

export type Role = 'user' | 'model';

export interface Attachment {
  name: string;
  mimeType: string;
  data: string; // Base64 encoded string still used for Gemini API for now
  url?: string; // Firebase Storage public URL
  size?: number;
  localId?: string;
}

export interface Citation {
  uri: string;
  title: string;
}

export interface ThingNatureScores {
  phi: { 
    L: number; // 逻辑性 Logic
    H: number; // 人性 Humanity
    R: number; // 稳健性 Robustness
    N: number; // 新颖度 Novelty
  };
  sigma_plus: number; // 正性账本 (-10 to 10)
  b_sigma: number; // 黑子密度 (0 to 10)
  pi_d: string; // 整合深度 "Low" | "Medium" | "High"
  action: 'PASS' | 'AUGMENT' | 'REJECT';
}

export interface NameInsight {
  name: string;
  role: string;
  summary: string;
  decomposition: string[];
  source: 'built-in' | 'custom';
}

export interface LockDragonDiagnosis {
  state: 'not_applicable' | 'locked' | 'releasing' | 'free';
  signals: string[];
  summary: string;
}

export interface WuxingDiagnosisSummary {
  responseMode: ResponseMode;
  engines: Array<'HFCD' | 'Genesis'>;
  lockDragon: LockDragonDiagnosis;
  names: NameInsight[];
  canonHits: CanonEntry[];
  canonRelations: CanonRelation[];
  recordRecommended: boolean;
  protocolNote: string;
  disableWebSearch: boolean;
}

export interface WuxingRecord {
  id: string;
  chatId: string;
  sourceMessageId: string;
  title: string;
  category: 'name-insight' | 'lock-dragon' | 'new-light';
  excerpt: string;
  createdAt: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  attachments?: Attachment[];
  citations?: Citation[];
  createdAt?: number;
  omega?: string; // e.g. "短期", "1年", "一生"
  tn_scores?: ThingNatureScores;
  isAugmented?: boolean; // PRA gate state
  wuxingDiagnosis?: WuxingDiagnosisSummary;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserSettings {
  systemInstruction: string;
  webSearchEnabled: boolean;
}
