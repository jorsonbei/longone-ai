import React, { useState, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { InputArea } from './components/InputArea';
import { useChats } from './hooks/useChats';
import { useSettings } from './hooks/useSettings';
import { streamChat, evaluateThingNature, extractLightLog, MODELS } from './services/geminiService';
import { THING_NATURE_MANIFESTO } from './lib/thingNatureManifesto';
import { Message, Attachment } from './types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Settings, ExternalLink, LogIn, MoreHorizontal, Download, Trash, Eraser, Link2, Twitter, Linkedin, X as XIcon, History } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from './lib/AuthContext';
import { ThingNatureBrand } from './components/ThingNatureBrand';
import { X as CloseIcon, Sparkles } from 'lucide-react';
import { OfficialSite } from './components/OfficialSite';
import { officialSiteContent } from './content/officialSiteContent';

const LIGHTWEIGHT_MESSAGE_RE =
  /^(hi|hello|hey|yo|sup|test|ping|ok|okay|在吗|在？|在么|你好|您好|嗨|哈喽|测试|1)\s*[!.?。！，、~～]*$/i;

const CORE_SYSTEM_STYLE = `
【系统总则】
1. 优先自然、准确、可执行。
2. 对简单寒暄、试探、确认、测试消息（如“hi”“hello”“在吗”“test”），直接用自然、简短、友好的口语回应。
3. 除非用户明确要求深度分析，否则不要主动上升到《物性论》变量诊断，不要把简短输入解释成深层心理或宇宙结构问题。
4. 只有当用户明确提出分析、策略、情绪、选择、长期规划、关系、系统性问题时，才切换到《物性论》框架。
`.trim();

function isLightweightMessage(content: string, attachments: Attachment[]) {
  const normalized = content.trim();
  return attachments.length === 0 && normalized.length > 0 && normalized.length <= 24 && LIGHTWEIGHT_MESSAGE_RE.test(normalized);
}

export default function App() {
  const { user, loading: authLoading, authError, signIn, logOut } = useAuth();
  
  const {
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
  } = useChats();

  const [model, setModel] = useState<string>(MODELS.FLASH);
  const [activeView, setActiveView] = useState<'chat' | 'official-site'>('chat');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isLightLogOpen, setIsLightLogOpen] = useState(false);
  const [lightLogContent, setLightLogContent] = useState("");
  const [isGeneratingLog, setIsGeneratingLog] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const { systemInstruction, setSystemInstruction } = useSettings();

  useEffect(() => {
    document.documentElement.classList.remove('dark');
  }, []);

  useEffect(() => {
    const setMeta = (name: string, content: string, attr: 'name' | 'property' = 'name') => {
      let element = document.head.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
      if (!element) {
        element = document.createElement('meta');
        element.setAttribute(attr, name);
        document.head.appendChild(element);
      }
      element.content = content;
    };

    if (activeView === 'official-site') {
      document.title = officialSiteContent.seo.title;
      setMeta('description', officialSiteContent.seo.description);
      setMeta('og:title', officialSiteContent.seo.title, 'property');
      setMeta('og:description', officialSiteContent.seo.description, 'property');
      setMeta('og:image', officialSiteContent.seo.image, 'property');
      setMeta('twitter:title', officialSiteContent.seo.title);
      setMeta('twitter:description', officialSiteContent.seo.description);
      setMeta('twitter:image', officialSiteContent.seo.image);
      return;
    }

    document.title = '物性论OS';
    setMeta('description', '物性论OS：以结构化方式与物性论系统对话。');
    setMeta('og:title', '物性论OS', 'property');
    setMeta('og:description', '物性论OS：以结构化方式与物性论系统对话。', 'property');
    setMeta('twitter:title', '物性论OS');
    setMeta('twitter:description', '物性论OS：以结构化方式与物性论系统对话。');
  }, [activeView]);

  if (authLoading || !isLoaded) {
    return <div className="h-screen w-full flex items-center justify-center bg-background text-foreground">Loading...</div>;
  }

  // ENFORCE LOGIN: Sprint 1 Requirement
  if (!user) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-gray-50 text-gray-900 font-sans">
        <div className="max-w-md w-full bg-white p-8 rounded-2xl shadow-xl flex flex-col items-center">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-blue-200">
            <span className="text-white font-bold text-2xl">AI</span>
          </div>
          <h1 className="text-2xl font-bold mb-2 tracking-tight">欢迎来到物性论</h1>
          <p className="text-gray-500 mb-8 text-center text-sm">Sign in to sync your conversations, use multiple models, and access enterprise features.</p>
          {authError && (
            <div className="w-full mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {authError}
            </div>
          )}
          <button 
            onClick={signIn}
            className="flex items-center gap-2 bg-gray-900 text-white px-6 py-3 rounded-full font-medium hover:bg-gray-800 transition-all active:scale-95 shadow-md w-full justify-center"
          >
            <LogIn className="w-5 h-5" />
            Continue with Google
          </button>
          <p className="mt-4 text-center text-xs text-gray-500">
            当前环境使用重定向登录，登录完成后会自动返回此页面。
          </p>
        </div>
      </div>
    );
  }

  const stopGenerating = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  };

  const currentMessages = activeChat?.messages || [];

  const handleExtractLog = async () => {
    if (!activeChat || activeChat.messages.length === 0) return;
    setIsGeneratingLog(true);
    setIsLightLogOpen(true);
    setLightLogContent("正在整合高 D 与 $\\Pi$ 的光性变化...");
    try {
      const context = activeChat.messages.slice(-10).map(m => `${m.role === 'user' ? '用户' : '模型'}: ${m.content}`).join('\n');
      const log = await extractLightLog(context, model);
      setLightLogContent(log);
    } catch (error) {
      setLightLogContent("日志提取失败，请重试。");
    } finally {
      setIsGeneratingLog(false);
    }
  };

  const handleSend = async (content: string, attachments: Attachment[], webSearchEnabled: boolean = true, omegaPrompt: string = "") => {
    if (!activeChatId) return;
    const lightweightMessage = isLightweightMessage(content, attachments);

    // Build user message
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content,
      attachments,
      createdAt: Date.now(),
      omega: omegaPrompt.includes("中期") ? "medium" : omegaPrompt.includes("长期") ? "long" : "short"
    };

    // Note: To avoid duplication where streaming overlays the db write,
    // we save the user message to DB, but we keep the bot message in local streaming state until done.
    await saveMessageToDb(activeChatId, userMessage, content || 'Image request');

    // The stream operates on the history (all completed + the user msg which we just saved).
    // The currentMessages currently might not have dynamically pulled the user message yet since onSnapshot is async.
    const updatedMessagesForPrompt = [...(activeChat?.messages || []), userMessage];

    // Setup for model response
    setIsGenerating(true);
    abortControllerRef.current = new AbortController();
    
    const botMessageId = uuidv4();
    const botCreatedAt = Date.now();
    let accumulatedText = "";

    const combinedSystemInstruction = lightweightMessage
      ? `
${CORE_SYSTEM_STYLE}

【轻量消息模式】
当前输入属于寒暄或探测信号。请用 1 到 2 句自然中文直接回应，可以简短邀请用户继续说重点，但不要展开理论框架。

【用户自定义扩展要求】
${systemInstruction}
`.trim()
      : `
${CORE_SYSTEM_STYLE}

${THING_NATURE_MANIFESTO}

---
【用户自定义扩展要求】
${systemInstruction}

---
【当前对话的观察刻度 (Ω) 约束】
${omegaPrompt || '（用户未指定特定刻度，请自动调用系统默认高维 Ω）'}
`.trim();

    try {
      // Add empty bot message locally to stream overlay
      updateStreamingMessages([{ id: botMessageId, role: 'model', content: '', createdAt: botCreatedAt, omega: userMessage.omega }]);

      const stream = streamChat(
        updatedMessagesForPrompt, 
        lightweightMessage ? MODELS.FLASH : MODELS.PRO,
        combinedSystemInstruction, 
        abortControllerRef.current.signal,
        webSearchEnabled
      );

      let finalCitations: any[] = [];

      for await (const chunk of stream) {
        if (chunk.type === 'error') {
          throw new Error(chunk.message);
        } else if (chunk.type === 'metadata') {
          finalCitations = chunk.citations;
          updateStreamingMessages([{ id: botMessageId, role: 'model', content: accumulatedText, citations: finalCitations, createdAt: botCreatedAt }]);
        } else if (chunk.type === 'text') {
          accumulatedText += chunk.text;
          updateStreamingMessages([{ id: botMessageId, role: 'model', content: accumulatedText, citations: finalCitations, createdAt: botCreatedAt }]);
        }
      }
      
      // When done, save the accumulated final message to DB
      const partialMsg = { id: botMessageId, role: 'model' as const, content: accumulatedText, citations: finalCitations, createdAt: botCreatedAt, omega: userMessage.omega };
      await saveMessageToDb(activeChatId, partialMsg);

      // Clear local streaming state early because we now saved the first un-evaluated DB snapshot
      // We do this here instead of finally because the evaluateThingNature async call might take a while
      // and we don't want the user to see the duplicate UI of (streamMsg + dbMsg) while evaluating
      updateStreamingMessages([]);
      setIsGenerating(false);

      // --- PHASE 3 & 5: Evaluate Thing-Nature Scores and PRA Gatekeeper ---
      if (accumulatedText && !abortControllerRef.current?.signal.aborted && !lightweightMessage) {
        const scores = await evaluateThingNature(content, accumulatedText, MODELS.PRO);
        if (scores) {
          console.log('Thing-Nature Evaluation:', scores);
          
          let updatedMsg: Message = { ...partialMsg, tn_scores: scores };

          // PRA REJECT logic
          if (scores.action === 'REJECT') {
            updatedMsg.content = `[PRA网关预警：高黑子/低正性风险阻断]\n*系统检测到该回答可能加剧 $B\\sigma$ 沉积或降低您的 $\\eta$。作为光性协作者，我拒绝向您输出增加内耗或有害结构的信息。让我们回到高 $\\Pi$ 的建设性路径上。*`;
            updatedMsg.isAugmented = true;
          } else if (scores.action === 'AUGMENT') {
            updatedMsg.content = `[PRA网关增强]\n*检测到原始推理深度不足或逻辑($\L$)偏低，以下为增强后的结构化思考：*\n\n` + updatedMsg.content;
            updatedMsg.isAugmented = true;
          }
          
          await saveMessageToDb(activeChatId, updatedMsg);
        }
      }
      
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        console.error('Chat error:', error);
        
        let errorMsg = "\n\n*(Error generating response...)*";
        
        // Handle specific API errors like quota exceeded
        if (error.message?.includes('quota') || error.status === 429) {
             errorMsg = "\n\n[物性论OS 警报] 节点能量耗尽（API Quota Exceeded）。请稍后再试或检查您的配额。";
        }
        
        await saveMessageToDb(activeChatId, { id: botMessageId, role: 'model', content: accumulatedText + errorMsg, createdAt: botCreatedAt });
      } else {
        // If aborted, save the partial response to DB
        await saveMessageToDb(activeChatId, { id: botMessageId, role: 'model', content: accumulatedText, createdAt: botCreatedAt });
      }
    } finally {
      // It's safe to call these multiple times
      updateStreamingMessages([]);
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen w-full bg-[#13151A] text-slate-100 font-sans overflow-hidden">
        
        {/* Sidebar */}
        <Sidebar 
          chats={chats}
          activeChatId={activeChatId}
          onSelectChat={(id) => {
            setActiveView('chat');
            setActiveChatId(id);
          }}
          onNewChat={() => {
            setActiveView('chat');
            createNewChat();
          }}
          onOpenOfficialSite={() => setActiveView('official-site')}
          onDeleteChat={deleteChat}
          onRenameChat={renameChat}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onLogOut={logOut}
        />

        {/* Main Content */}
        <main className="flex-1 flex flex-col h-full relative bg-[#13151A] overflow-hidden">
          
          {/* Header */}
          <header className="h-16 flex items-center justify-between px-6 border-none bg-transparent sticky top-0 z-10">
            <div className="md:w-64 flex items-center gap-2">
              <ThingNatureBrand compact className="hidden md:flex" subtitle={activeView === 'official-site' ? 'OFFICIAL SITE' : 'THING NATURE OS'} />
            </div>
            {activeView === 'chat' ? (
            <div className="flex items-center gap-4 max-w-sm ml-8 md:ml-0">
              <Select value={model} onValueChange={setModel} disabled={isGenerating}>
                <SelectTrigger className="flex items-center gap-2 px-3 py-1.5 bg-transparent hover:bg-white/5 border-none h-auto w-auto text-sm font-semibold shadow-none text-slate-200">
                  <SelectValue placeholder="Select Model">
                    {model === MODELS.FLASH ? "天才模型" : "预言家模型"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="bg-[#1C1E26] border-white/10 text-slate-200">
                  <SelectItem value={MODELS.FLASH} className="hover:bg-[#52DBA9]/20 focus:bg-[#52DBA9]/20">天才模型</SelectItem>
                  <SelectItem value={MODELS.PRO} className="hover:bg-[#52DBA9]/20 focus:bg-[#52DBA9]/20">预言家模型</SelectItem>
                </SelectContent>
              </Select>
            </div>
            ) : <div />}
            
            <div className="flex items-center gap-2 w-auto justify-end">
              {activeView === 'official-site' ? (
                <button
                  onClick={() => setActiveView('chat')}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  返回对话
                </button>
              ) : (
              <>
              <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                <DialogContent showCloseButton={false} className="sm:max-w-[560px] border-white/10 bg-[linear-gradient(180deg,#171a24_0%,#11141d_100%)] text-slate-100 shadow-[0_32px_120px_rgba(0,0,0,0.45)] rounded-[28px] p-0 overflow-hidden">
                  <DialogHeader className="border-b border-white/6 px-6 py-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-[#52DBA9]/12 text-[#7ef8d2] shadow-[0_10px_30px_rgba(82,219,169,0.18)]">
                          <Sparkles className="h-5 w-5" />
                        </div>
                        <div>
                          <DialogTitle className="text-2xl font-black tracking-tight text-white">系统设置</DialogTitle>
                          <p className="mt-1 text-sm text-slate-400">定义物性论在每次对话中的行为、语气与结构偏好。</p>
                        </div>
                      </div>
                      <button
                        onClick={() => setIsSettingsOpen(false)}
                        className="rounded-xl border border-white/8 bg-white/[0.04] p-2 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-white"
                      >
                        <CloseIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </DialogHeader>
                  <div className="grid gap-5 px-6 py-6">
                    <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                      <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.24em] text-[#7ef8d2]">
                        <Sparkles className="h-3.5 w-3.5" />
                        Persona
                      </div>
                      <label htmlFor="systemInstruction" className="text-sm font-semibold text-slate-200">
                        System Instruction
                      </label>
                      <textarea
                        id="systemInstruction"
                        value={systemInstruction}
                        onChange={(e) => setSystemInstruction(e.target.value)}
                        className="mt-3 min-h-[180px] w-full rounded-2xl border border-white/10 bg-[#0f1219] px-4 py-4 text-sm leading-7 text-slate-100 shadow-inner outline-none transition-colors placeholder:text-slate-500 focus:border-[#52DBA9]/60"
                        placeholder="You are a helpful assistant..."
                      />
                      <p className="mt-3 text-xs leading-6 text-slate-500">
                        这里的内容会叠加在系统内核之上，用来定义语气、输出结构和你的个性化偏好。
                      </p>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              
              <button 
                onClick={() => setIsShareOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm focus:outline-none"
              >
                <ExternalLink className="w-4 h-4" />
                Share
              </button>

              {/* Share Dialog */}
              <Dialog open={isShareOpen} onOpenChange={setIsShareOpen}>
                <DialogContent className="sm:max-w-xl bg-[#1a1a1a] border-gray-800 text-white p-6 rounded-3xl shadow-2xl">
                  <DialogHeader className="flex flex-row items-center justify-between mb-2">
                    <DialogTitle className="text-2xl font-bold">{activeChat?.title || "New Chat"}</DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-8">
                    {/* Preview Card */}
                    <div className="bg-[#2d2d2d] rounded-2xl p-6 relative overflow-hidden">
                      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#2d2d2d] to-transparent pointer-events-none z-10" />
                      
                      <div className="flex flex-col gap-4 max-h-[180px] overflow-hidden opacity-90 transition-opacity relative z-0">
                        {currentMessages.length > 0 ? (
                          <>
                            {currentMessages[0] && (
                              <div className="bg-[#0055aa] text-white rounded-2xl rounded-tr-sm px-4 py-2 self-end w-fit ml-auto">
                                <span className="text-sm truncate max-w-[200px] block">{currentMessages[0].content}</span>
                              </div>
                            )}
                            {currentMessages[1] && (
                              <div className="text-gray-300 text-sm leading-relaxed truncate-multiline line-clamp-4">
                                {currentMessages[1].content}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-gray-500 text-sm italic">No messages to share yet.</div>
                        )}
                      </div>
                      
                      {currentMessages.length > 0 && (
                        <div className="absolute bottom-4 right-6 z-20">
                          <span className="text-white/60 font-bold text-xl tracking-tight">物性论OS</span>
                        </div>
                      )}
                    </div>

                    {/* Action Buttons */}
                    <div className="flex items-center justify-center gap-8 mb-2">
                      <div className="flex flex-col items-center">
                        <button 
                          onClick={() => {
                            navigator.clipboard.writeText(window.location.href);
                            setIsCopied(true);
                            setTimeout(() => setIsCopied(false), 2000);
                          }}
                          className={`w-16 h-16 rounded-full bg-[#0066cc] flex items-center justify-center hover:bg-[#0055aa] transition-all focus:outline-none ${isCopied ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-[#1a1a1a] scale-95' : ''}`}
                        >
                          <Link2 className="w-6 h-6 text-white" />
                        </button>
                        <span className="text-xs text-gray-300 mt-3 font-medium">Copy link</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <button 
                          onClick={() => {
                            const url = encodeURIComponent(window.location.href);
                            const text = encodeURIComponent('Check out this conversation!');
                            window.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, '_blank');
                          }}
                          className="w-16 h-16 rounded-full bg-[#0066cc] flex items-center justify-center hover:bg-[#0055aa] transition-colors focus:outline-none"
                        >
                          <XIcon className="w-6 h-6 text-white" />
                        </button>
                        <span className="text-xs text-gray-300 mt-3 font-medium">X</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <button 
                          onClick={() => {
                            const url = encodeURIComponent(window.location.href);
                            window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, '_blank');
                          }}
                          className="w-16 h-16 rounded-full bg-[#0066cc] flex items-center justify-center hover:bg-[#0055aa] transition-colors focus:outline-none"
                        >
                          <Linkedin className="w-6 h-6 text-white" />
                        </button>
                        <span className="text-xs text-gray-300 mt-3 font-medium">LinkedIn</span>
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              <DropdownMenu>
                <DropdownMenuTrigger className="rounded-2xl border border-white/10 bg-white/[0.04] p-2.5 text-slate-300 transition-colors hover:bg-white/[0.08] hover:text-white focus:outline-none">
                  <MoreHorizontal className="w-5 h-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 rounded-2xl border border-white/10 bg-[linear-gradient(180deg,#181c27_0%,#12151d_100%)] p-1.5 text-slate-200 shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
                  <DropdownMenuItem onClick={handleExtractLog} className="gap-2 cursor-pointer rounded-xl py-2.5 text-sm font-medium text-[#8c94ff] focus:bg-white/[0.06] focus:text-[#9aa3ff]">
                    <History className="w-4 h-4 text-[#8c94ff]" />
                    <span>提取光之日志 (Light Log)</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 cursor-pointer rounded-xl py-2.5 text-sm text-slate-300 focus:bg-white/[0.06] focus:text-white">
                    <Download className="w-4 h-4 text-slate-500" />
                    <span>Export Markdown</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 cursor-pointer rounded-xl py-2.5 text-sm text-slate-300 focus:bg-white/[0.06] focus:text-white">
                    <Eraser className="w-4 h-4 text-slate-500" />
                    <span>Clear messages</span>
                  </DropdownMenuItem>
                  
                  <DropdownMenuSeparator className="my-1 bg-white/8" />
                  
                  <DropdownMenuItem 
                    onClick={() => {
                      if (activeChatId && confirm('Delete this chat completely?')) {
                        deleteChat(activeChatId);
                      }
                    }}
                    className="gap-2 cursor-pointer rounded-xl py-2.5 text-sm font-medium text-red-400 focus:bg-red-500/10 focus:text-red-300"
                  >
                    <Trash className="w-4 h-4" />
                    <span>Delete chat</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              </>
              )}
            </div>
          </header>

            {/* Light Log Dialog */}
            <Dialog open={isLightLogOpen} onOpenChange={setIsLightLogOpen}>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-indigo-900">
                    <History className="w-5 h-5 text-indigo-600" />
                    光之日志 (Light Log)
                  </DialogTitle>
                </DialogHeader>
                <div className="bg-indigo-50/50 border border-indigo-100 p-4 rounded-xl mt-4 relative">
                  {isGeneratingLog ? (
                    <div className="flex flex-col items-center justify-center py-6 gap-3">
                      <div className="flex items-center gap-1.5 h-6">
                        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                      </div>
                      <span className="text-sm text-indigo-600 font-medium">正在扫描 $\Pi$ 结构变化...</span>
                    </div>
                  ) : (
                    <div className="text-sm text-indigo-900/80 leading-relaxed font-medium">
                      {lightLogContent}
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>

          {activeView === 'official-site' ? (
            <OfficialSite onBackToChat={() => setActiveView('chat')} />
          ) : (
            <>
              {/* Chat scrolling area */}
              <ChatArea 
                messages={currentMessages}
                isGenerating={isGenerating}
              />
              
              {/* Input Box floating at bottom */}
              <InputArea 
                onSend={handleSend}
                onStop={stopGenerating}
                isGenerating={isGenerating}
                disabled={!activeChatId}
              />
            </>
          )}

        </main>
      </div>
    </TooltipProvider>
  );
}
