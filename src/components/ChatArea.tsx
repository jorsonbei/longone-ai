import React, { useState } from 'react';
import { Message } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { User, Copy, Check, Globe, Shield, Activity, GitBranch, ShieldAlert, Paperclip, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { format } from 'date-fns';
import { useAuth } from '../lib/AuthContext';
import { ThingNatureMark } from './ThingNatureBrand';
import type { UiText } from '../content/uiText';

interface ChatAreaProps {
  messages: Message[];
  isGenerating: boolean;
  onRetryMessage?: (messageId: string) => void;
  ui: UiText;
}

export function ChatArea({ messages, isGenerating, onRetryMessage, ui }: ChatAreaProps) {
  const { user } = useAuth();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const prevMessageCountRef = React.useRef(messages.length);
  const prevLastMessageIdRef = React.useRef<string | null>(messages[messages.length - 1]?.id || null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  React.useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const currentLastMessageId = messages[messages.length - 1]?.id || null;
    const hasNewMessage =
      messages.length > prevMessageCountRef.current || currentLastMessageId !== prevLastMessageIdRef.current;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceFromBottom < 120;

    if (hasNewMessage && (isNearBottom || !isGenerating)) {
      container.scrollTop = container.scrollHeight;
    }

    prevMessageCountRef.current = messages.length;
    prevLastMessageIdRef.current = currentLastMessageId;
  }, [messages, isGenerating]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatFileSize = (size?: number) => {
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex-1 overflow-y-auto w-full p-4 md:p-6" ref={scrollRef}>
      <div className="flex flex-col gap-6 w-full max-w-3xl mx-auto pb-32">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center text-center text-slate-400 pt-20">
            <ThingNatureMark className="mb-4 h-12 w-12 rounded-[1.1rem] opacity-90" />
            <h2 className="text-2xl font-semibold mb-2 text-slate-200 tracking-tight">{ui.chat.emptyTitle}</h2>
            <p className="text-sm">{ui.chat.emptySubtitle}</p>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className="flex w-full gap-4"
          >
            {m.role === 'user' ? (
              <Avatar className="w-8 h-8 flex-shrink-0 border border-white/5 shadow-sm">
                {user?.photoURL ? (
                  <AvatarImage src={user.photoURL} alt={user.displayName || "User"} />
                ) : null}
                <AvatarFallback className="bg-[#252833] text-slate-300">
                  <User className="w-5 h-5" />
                </AvatarFallback>
              </Avatar>
            ) : (
              <ThingNatureMark className="h-8 w-8 flex-shrink-0 rounded-full" />
            )}

            <div className={cn(
              "flex flex-col gap-2 relative group mt-1",
              m.role === 'user' ? "flex-1" : "flex-1 min-w-0"
            )}>
              {m.role === 'user' ? (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="text-sm font-bold text-slate-200">{user?.displayName || ui.chat.userLabel}</div>
                    {m.createdAt && (
                      <div className="text-[11px] text-slate-500 font-normal">
                        {format(m.createdAt, 'MMM d, h:mm a')}
                      </div>
                    )}
                  </div>
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                       {m.attachments.map((att, i) => (
                        <div key={i} className="relative rounded-xl overflow-hidden border border-white/10 max-w-[180px] bg-[#1C1E26]">
                          {att.mimeType.startsWith('image/') ? (
                             <img src={att.url || `data:${att.mimeType};base64,${att.data}`} alt="attachment" className="object-cover w-full h-auto max-h-[150px]" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="flex items-center gap-2 p-3 bg-white/5">
                              <Paperclip className="w-4 h-4 text-slate-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-xs truncate text-slate-300">{att.name}</div>
                                {att.size ? <div className="text-[10px] text-slate-500">{formatFileSize(att.size)}</div> : null}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-[15px] leading-relaxed text-slate-300 whitespace-pre-wrap">{m.content}</div>
                </>
              ) : (
                <>
                  <div className="text-sm font-bold mb-1 text-[#52DBA9] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {m.createdAt && (
                        <span className="text-[11px] font-normal text-slate-500 mt-0.5">
                          {format(m.createdAt, 'MMM d, h:mm a')}
                        </span>
                      )}
                    </div>
                    <button 
                      onClick={() => handleCopy(m.id, m.content)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 hover:bg-white/5 rounded-md text-slate-400"
                      title={ui.chat.copyResponse}
                    >
                      {copiedId === m.id ? <Check className="w-4 h-4 text-[#52DBA9]" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="text-[15px] text-slate-300 leading-relaxed w-full">
                    {m.content ? (
                      <MarkdownRenderer content={m.content} />
                    ) : (
                      (isGenerating || m.status === 'streaming') && (
                        <div className="flex items-center gap-1.5 h-6 pt-1">
                          <span className="w-2 h-2 rounded-full bg-[#52DBA9]/50 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                          <span className="w-2 h-2 rounded-full bg-[#52DBA9]/50 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                          <span className="w-2 h-2 rounded-full bg-[#52DBA9]/50 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                        </div>
                      )
                    )}

                    {m.status === 'error' && onRetryMessage ? (
                      <div className="mt-4">
                        <button
                          onClick={() => onRetryMessage(m.id)}
                          className="inline-flex items-center gap-2 rounded-xl border border-[#52DBA9]/20 bg-[#52DBA9]/8 px-3 py-2 text-sm font-medium text-[#7ef8d2] transition-colors hover:bg-[#52DBA9]/14"
                        >
                          <RotateCcw className="h-4 w-4" />
                          {ui.chat.retryResponse}
                        </button>
                      </div>
                    ) : null}
                    
                    {/* Citations block */}
                    {m.citations && m.citations.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-white/5">
                        <div className="flex items-center gap-2 text-xs font-semibold text-slate-400 mb-2">
                          <Globe className="w-3.5 h-3.5" />
                          {ui.chat.sources}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {m.citations.map((c, i) => (
                            <a 
                              key={i} 
                              href={c.uri} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="inline-flex items-center max-w-[200px] gap-1 px-2.5 py-1.5 bg-[#252833] hover:bg-[#2A2E39] border border-white/5 rounded-md text-xs text-slate-300 transition-colors"
                            >
                              <div className="truncate">{c.title || new URL(c.uri).hostname}</div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Thing-Nature Dashboard (Phase 3) */}
                    {m.tn_scores && (
                      <div className="mt-5 p-4 bg-[#1C1E26] border border-white/5 rounded-xl relative group/dashboard shadow-sm">
                        <div className="flex items-center gap-2 text-xs font-bold text-slate-400 tracking-wider uppercase mb-4 opacity-80 group-hover/dashboard:opacity-100 transition-opacity">
                          <Activity className="w-4 h-4 text-[#52DBA9]" />
                          光性仪表盘 (Thing-Nature Audit)
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          {/* Phi Vector */}
                          <div className="flex flex-col bg-[#13151A] border border-white/5 rounded-lg p-3">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-medium">φ 结构</span>
                            <div className="flex items-center justify-between text-xs font-mono text-slate-300 mb-1">
                              <span>L:{m.tn_scores.phi?.L}</span><span>H:{m.tn_scores.phi?.H}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs font-mono text-slate-300">
                              <span>R:{m.tn_scores.phi?.R}</span><span>N:{m.tn_scores.phi?.N}</span>
                            </div>
                          </div>
                          
                          {/* Pi Depth */}
                          <div className="flex flex-col bg-[#13151A] border border-white/5 rounded-lg p-3">
                            <span className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-medium">ΠD (整合度)</span>
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200 mt-auto">
                              <GitBranch className="w-4 h-4 text-[#52DBA9]" />
                              {m.tn_scores.pi_d}
                            </div>
                          </div>

                          {/* Sigma Plus */}
                          <div className="flex flex-col bg-[#13151A] border border-emerald-500/20 rounded-lg p-3 relative overflow-hidden">
                            <div className="absolute inset-0 bg-emerald-500/5" />
                            <span className="text-[10px] text-emerald-500 uppercase tracking-wider mb-2 font-medium relative z-10">Σ⁺ (正性输出)</span>
                            <div className="flex items-center text-lg font-bold text-emerald-400 mt-auto leading-none relative z-10">
                              {m.tn_scores.sigma_plus > 0 ? '+' : ''}{m.tn_scores.sigma_plus}
                            </div>
                          </div>

                          {/* B Sigma */}
                          <div className="flex flex-col bg-[#13151A] border border-rose-500/20 rounded-lg p-3 relative overflow-hidden">
                            <div className="absolute inset-0 bg-rose-500/5" />
                            <span className="text-[10px] text-rose-500/80 uppercase tracking-wider mb-2 font-medium relative z-10">Bσ (黑子风险)</span>
                            <div className="flex items-center gap-1.5 text-sm font-bold text-rose-400 mt-auto leading-none relative z-10">
                              {m.tn_scores.b_sigma > 5 ? <ShieldAlert className="w-4 h-4" /> : <Shield className="w-4 h-4 opacity-50" />}
                              {m.tn_scores.b_sigma} / 10
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                  </div>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
