import React, { useRef, useState, useEffect } from 'react';
import { Paperclip, X, Square, Globe, Mic, MicOff, Telescope, Search, Eye, ArrowUp, FileText, Image as ImageIcon, FileArchive, Inbox } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Attachment } from '../types';
import { storage } from '../lib/firebase';
import { UploadTask, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { useAuth } from '../lib/AuthContext';
import { v4 as uuidv4 } from 'uuid';
import { cn } from '@/lib/utils';

interface InputAreaProps {
  onSend: (content: string, attachments: Attachment[], webSearch: boolean, omega: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled: boolean;
}

type UploadStatus = {
  id: string;
  name: string;
  progress: number;
  stage: 'reading' | 'uploading' | 'complete' | 'failed';
};

const MAX_FILE_SIZE_MB = 50;
const SUPPORTED_FILE_TYPES = 'image/*,application/pdf,.txt,.md,.csv,.json,.py,.js,.jsx,.ts,.tsx,.java,.c,.cpp,.h,.hpp,.rs,.go,.sh,.yaml,.yml,.toml,.ini,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
const INLINE_ATTACHMENT_DATA_LIMIT = 850_000;
const BACKGROUND_UPLOAD_TIMEOUT_MS = 20_000;
const TEXT_FILE_EXTENSIONS = [
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.rs',
  '.go',
  '.sh',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
];

const OMEGA_SCALES = [
  { id: 'short', label: '短期 Ω', icon: Search, desc: '解决当下问题，直接给答案', prompt: '【系统指令：请使用「短期 Ω 刻度」，忽略宏大叙事，只解决用户当前亟待解决的局部问题，直接给出高信息密度（Id）的答案。】' },
  { id: 'medium', label: '三年 Ω', icon: Eye, desc: '看系统发展，给中期策略', prompt: '【系统指令：请使用「中期 Ω 刻度（1-3年）」，不仅解决当前问题，更要评估这个动作对用户物性向量 φ（能力/性格/结构）的长期影响，提出系统性建议。】' },
  { id: 'long', label: '一生 Ω', icon: Telescope, desc: '对齐宇宙母体，看文明路线', prompt: '【系统指令：请使用「长期 Ω 刻度（一生/文明尺度）」，跳出日常繁琐，过滤掉暂时情绪噪音，直接逼问这个动作是否能带来绝对的净正性（Σ⁺），是否符合用户的跨时间文明路线。如果用户深陷黑子（Bσ）情绪，请启动 PRA 拒答或重构引导。】' }
];

export function InputArea({ onSend, onStop, isGenerating, disabled }: InputAreaProps) {
  const { workspaceId } = useAuth();
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadStatus[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [activeOmega, setActiveOmega] = useState(OMEGA_SCALES[0]);
  
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const uploadTaskRef = useRef<Record<string, UploadTask>>({});
  const fileReaderRef = useRef<Record<string, FileReader>>({});
  const uploadTimeoutRef = useRef<Record<string, number>>({});

  const formatFileSize = (size?: number) => {
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getAttachmentIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) return ImageIcon;
    if (mimeType.includes('pdf') || mimeType.includes('word') || mimeType.includes('sheet') || mimeType.includes('presentation') || mimeType.includes('text')) return FileText;
    return FileArchive;
  };

  const upsertUploadStatus = (nextStatus: UploadStatus) => {
    setUploadProgress((prev) => {
      const index = prev.findIndex((item) => item.id === nextStatus.id);
      if (index === -1) return [...prev, nextStatus];
      const next = [...prev];
      next[index] = nextStatus;
      return next;
    });
  };

  const removeUploadStatus = (id: string, delay = 1200) => {
    window.setTimeout(() => {
      setUploadProgress((prev) => prev.filter((item) => item.id !== id));
    }, delay);
  };

  const clearUploadTimeout = (id: string) => {
    const timeoutId = uploadTimeoutRef.current[id];
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      delete uploadTimeoutRef.current[id];
    }
  };

  const clearUploadResources = (id: string) => {
    clearUploadTimeout(id);
    delete uploadTaskRef.current[id];
    delete fileReaderRef.current[id];
  };

  const getUploadStatus = (id?: string) => {
    if (!id) return null;
    return uploadProgress.find((item) => item.id === id) || null;
  };

  const cancelUpload = (id: string) => {
    fileReaderRef.current[id]?.abort();
    delete fileReaderRef.current[id];

    uploadTaskRef.current[id]?.cancel();
    delete uploadTaskRef.current[id];
    clearUploadTimeout(id);

    setUploadProgress((prev) => prev.filter((item) => item.id !== id));
    setAttachments((prev) => prev.filter((item) => item.localId !== id));
  };

  useEffect(() => {
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      
      recognition.onresult = (event: any) => {
        let currentTranscript = '';
        for (let i = 0; i < event.results.length; ++i) {
          currentTranscript += event.results[i][0].transcript;
        }
        setContent(currentTranscript);
      };

      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      
      recognitionRef.current = recognition;
    }
    
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      if (recognitionRef.current) {
        setContent(''); // Optional: clear existing content before dictating
        recognitionRef.current.start();
        setIsListening(true);
      } else {
        alert("Your browser does not support Speech Recognition.");
      }
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '0px';
      const scrollHeight = textareaRef.current.scrollHeight;
      textareaRef.current.style.height = Math.min(scrollHeight, 200) + 'px';
    }
  }, [content]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if ((!content.trim() && attachments.length === 0) || isGenerating || isUploading) return;
    onSend(content.trim(), attachments, webSearchEnabled, activeOmega.prompt);
    setContent('');
    setAttachments([]);
    if (textareaRef.current) {
       textareaRef.current.style.height = 'auto';
    }
  };

  const processFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;

    setIsUploading(true);

    try {
      const preparedAttachments = await Promise.all(Array.from(files).map(async file => {
        if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
          alert(`File ${file.name} is too large. Max size is ${MAX_FILE_SIZE_MB}MB.`);
          return null;
        }

        const lowerName = file.name.toLowerCase();
        const isTextFile =
          file.type.startsWith('text/') ||
          TEXT_FILE_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
        const uploadId = uuidv4();
        upsertUploadStatus({ id: uploadId, name: file.name, progress: 0, stage: 'reading' });

        return new Promise<{ attachment: Attachment; file: File; uploadId: string; shouldUpload: boolean } | null>((resolve) => {
          const reader = new FileReader();
          fileReaderRef.current[uploadId] = reader;

          reader.onprogress = (event) => {
            if (!event.lengthComputable) return;
            const progress = Math.max(5, Math.round((event.loaded / event.total) * 35));
            upsertUploadStatus({ id: uploadId, name: file.name, progress, stage: 'reading' });
          };

          reader.onload = async (event) => {
            const result = event.target?.result as string;
            if (!result) {
              upsertUploadStatus({ id: uploadId, name: file.name, progress: 0, stage: 'failed' });
              removeUploadStatus(uploadId, 1800);
              delete fileReaderRef.current[uploadId];
              resolve(null);
              return;
            }

            try {
              let base64Data = '';

              if (isTextFile) {
                // If we read as text, result is the raw text. Convert it to base64 for Gemini inlineData
                // Use a safer text-to-base64 conversion for unicode out-of-bounds chars
                base64Data = btoa(
                    new Uint8Array(new TextEncoder().encode(result))
                      .reduce((data, byte) => data + String.fromCharCode(byte), '')
                );
              } else {
                // If read as Data URL, result is "data:image/png;base64,....."
                base64Data = result.split(',')[1];
              }
              const shouldUpload = Boolean(workspaceId && storage && base64Data.length > INLINE_ATTACHMENT_DATA_LIMIT);
              upsertUploadStatus({
                id: uploadId,
                name: file.name,
                progress: shouldUpload ? 42 : 100,
                stage: shouldUpload ? 'uploading' : 'complete',
              });

              resolve({
                attachment: {
                  name: file.name,
                  mimeType:
                    file.type ||
                    (lowerName.endsWith('.py')
                      ? 'text/x-python'
                      : lowerName.endsWith('.js')
                        ? 'text/javascript'
                        : lowerName.endsWith('.ts') || lowerName.endsWith('.tsx')
                          ? 'text/typescript'
                          : isTextFile
                            ? 'text/plain'
                            : 'application/octet-stream'),
                  data: base64Data, 
                  size: file.size,
                  localId: uploadId,
                },
                file,
                uploadId,
                shouldUpload,
              });
              delete fileReaderRef.current[uploadId];
            } catch(e) {
               console.error("Error processing file:", e);
               upsertUploadStatus({ id: uploadId, name: file.name, progress: 0, stage: 'failed' });
               removeUploadStatus(uploadId, 1800);
               delete fileReaderRef.current[uploadId];
               resolve(null);
            }
          };

          reader.onerror = () => {
            upsertUploadStatus({ id: uploadId, name: file.name, progress: 0, stage: 'failed' });
            removeUploadStatus(uploadId, 1800);
            delete fileReaderRef.current[uploadId];
            resolve(null);
          };

          if (isTextFile) {
            reader.readAsText(file);
          } else {
            reader.readAsDataURL(file);
          }
        });
      }));

      const readyFiles = preparedAttachments.filter(Boolean) as Array<{ attachment: Attachment; file: File; uploadId: string; shouldUpload: boolean }>;
      const newAttachments = readyFiles.map((item) => item.attachment);
      setAttachments(prev => [...prev, ...newAttachments]);

      // Upload to Firebase in the background so the UI becomes usable immediately.
      readyFiles.forEach(({ attachment, file, uploadId, shouldUpload }) => {
        if (!shouldUpload) {
          removeUploadStatus(uploadId);
          return;
        }

        if (!file || !uploadId || !workspaceId || !storage) {
          if (uploadId) {
            upsertUploadStatus({ id: uploadId, name: attachment.name, progress: 100, stage: 'complete' });
            removeUploadStatus(uploadId);
          }
          return;
        }

        const storageRef = ref(storage, `workspaces/${workspaceId}/attachments/${uploadId}_${file.name}`);
        const uploadTask = uploadBytesResumable(storageRef, file);
        uploadTaskRef.current[uploadId] = uploadTask;
        uploadTimeoutRef.current[uploadId] = window.setTimeout(() => {
          console.warn('Background attachment upload timed out. Falling back to local-only attachment.', attachment.name);
          uploadTask.cancel();
          clearUploadResources(uploadId);
          removeUploadStatus(uploadId, 0);
        }, BACKGROUND_UPLOAD_TIMEOUT_MS);
        uploadTask.on(
          'state_changed',
          (snapshot) => {
            const progress = snapshot.totalBytes > 0 ? Math.max(42, Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)) : 42;
            upsertUploadStatus({ id: uploadId, name: attachment.name, progress, stage: 'uploading' });
            clearUploadTimeout(uploadId);
            uploadTimeoutRef.current[uploadId] = window.setTimeout(() => {
              console.warn('Background attachment upload stalled. Falling back to local-only attachment.', attachment.name);
              uploadTask.cancel();
              clearUploadResources(uploadId);
              removeUploadStatus(uploadId, 0);
            }, BACKGROUND_UPLOAD_TIMEOUT_MS);
          },
          (storageError) => {
            console.warn('Background attachment upload failed. Falling back to local-only attachment.', storageError);
            clearUploadResources(uploadId);
            removeUploadStatus(uploadId, 0);
          },
          async () => {
            try {
              const downloadURL = await getDownloadURL(storageRef);
              setAttachments((prev) =>
                prev.map((item) => (item.localId === attachment.localId ? { ...item, url: downloadURL } : item))
              );
              upsertUploadStatus({ id: uploadId, name: attachment.name, progress: 100, stage: 'complete' });
              removeUploadStatus(uploadId);
            } catch (downloadError) {
              console.warn('Attachment uploaded but download URL fetch failed. Falling back to local-only attachment.', downloadError);
              removeUploadStatus(uploadId, 0);
            } finally {
              clearUploadResources(uploadId);
            }
          },
        );
      });
      
    } catch (error) {
      console.error("Upload error:", error);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await processFiles(e.target.files || []);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (disabled || isUploading) return;
    await processFiles(e.dataTransfer.files);
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <footer className="w-full bg-[#13151A] p-4 md:p-6 pb-6 md:pb-8 sticky bottom-0 z-10 shrink-0">
      <div className="max-w-3xl mx-auto relative px-0">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="bg-[#1C1E26] rounded-[32px] shadow-xl p-1.5 flex flex-col border border-white/5 focus-within:border-white/10 transition-colors"
        >
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            className="hidden" 
            multiple 
            accept={SUPPORTED_FILE_TYPES}
          />

          <div className="mx-2 mt-2 flex items-center gap-2 rounded-2xl border border-dashed border-white/6 bg-white/[0.015] px-3 py-2 text-[10px] text-slate-600">
            <Inbox className="h-3 w-3 text-[#52DBA9]/80" />
            <span>拖拽或粘贴文件</span>
          </div>

          {(attachments.length > 0 || uploadProgress.length > 0) && (
            <div className="mx-2 mt-2 flex flex-wrap gap-2 rounded-[28px] border border-white/8 bg-[#181b24] p-3">
              {attachments.map((att, i) => (
                <div key={att.localId || i} className="group relative w-[124px] shrink-0">
                  <div className="overflow-hidden rounded-[24px] border border-white/10 bg-[#252833] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                    {att.mimeType.startsWith('image/') ? (
                      <img src={`data:${att.mimeType};base64,${att.data}`} alt="preview" className="h-[100px] w-full rounded-[18px] object-cover" />
                    ) : (
                      <div className="flex h-[100px] w-full items-center justify-center rounded-[18px] bg-white/5">
                        {React.createElement(getAttachmentIcon(att.mimeType), { className: 'w-7 h-7 text-slate-300' })}
                      </div>
                    )}

                    {getUploadStatus(att.localId) && (
                      <div className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#181b24]/92 backdrop-blur-sm">
                        <div className="h-7 w-7 rounded-full border-[3px] border-white/12 border-t-white animate-spin" style={{ animationDuration: '0.9s' }} />
                      </div>
                    )}

                    {!getUploadStatus(att.localId) && att.url && (
                      <div className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#181b24]/92 text-[#7ef8d2] backdrop-blur-sm animate-in fade-in-0 zoom-in-95 duration-300">
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </div>
                    )}

                    <button
                      onClick={() => (att.localId ? cancelUpload(att.localId) : removeAttachment(i))}
                      className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-[#181b24]/94 text-white opacity-0 transition-all duration-200 group-hover:opacity-100 hover:bg-black/85"
                    >
                      <X className="w-5 h-5" />
                    </button>

                    <div className="mt-2 min-w-0">
                      <div title={att.name} className="truncate text-[12px] font-medium text-slate-200 transition-colors group-hover:text-white">
                        {att.name}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
                        {att.size ? <span>{formatFileSize(att.size)}</span> : null}
                        <span className="text-slate-700">•</span>
                        {getUploadStatus(att.localId) ? (
                          <span className="text-[#7ee8d0]">{getUploadStatus(att.localId)?.progress}%</span>
                        ) : att.url ? (
                          <span className="text-[#52DBA9]">完成</span>
                        ) : (
                          <span>本地</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          <Textarea
            ref={textareaRef}
            placeholder={isGenerating ? "正在生成回答..." : "向物性论发送消息..."}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className="w-full p-3 text-base focus-visible:ring-0 resize-none placeholder:text-slate-500 border-0 shadow-none bg-transparent min-h-[64px] max-h-[320px] text-slate-200"
            rows={2}
          />
          
          <div className="flex items-center justify-between px-2 pt-2 pb-1 bg-transparent">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  className="p-2 hover:bg-white/5 rounded-lg text-slate-400 w-9 h-9 flex shrink-0 items-center justify-center transition-colors disabled:opacity-50"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled}
                >
                  <Paperclip className="w-4 h-4" />
                </TooltipTrigger>
                <TooltipContent className="bg-[#252833] border-white/5 text-slate-200">Attach file</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  className={cn(
                    "p-2 hover:bg-white/5 rounded-lg w-9 h-9 flex shrink-0 items-center justify-center transition-colors disabled:opacity-50",
                    webSearchEnabled ? "text-[#52DBA9] bg-[#52DBA9]/10" : "text-slate-400"
                  )}
                  onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                  disabled={disabled}
                >
                  <Globe className="w-4 h-4" />
                </TooltipTrigger>
                <TooltipContent className="bg-[#252833] border-white/5 text-slate-200">Web Search {webSearchEnabled ? 'Enabled' : 'Disabled'}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger
                  className={cn(
                    "p-2 hover:bg-white/5 rounded-lg w-9 h-9 flex shrink-0 items-center justify-center transition-colors disabled:opacity-50",
                    isListening ? "text-red-400 bg-red-400/10 animate-pulse" : "text-slate-400"
                  )}
                  onClick={toggleListening}
                  disabled={disabled || !recognitionRef.current}
                >
                  {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </TooltipTrigger>
                <TooltipContent className="bg-[#252833] border-white/5 text-slate-200">{isListening ? 'Stop Dictation' : 'Start Dictation'}</TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={disabled}
                  className="px-2 py-1.5 hover:bg-white/5 rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50 text-slate-300 h-9 shrink-0 ml-1 focus:outline-none"
                >
                  <activeOmega.icon className="w-4 h-4" />
                  <span className="text-xs font-medium hidden sm:inline-block">{activeOmega.label}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-56 bg-[#252833] border-white/10 shadow-xl rounded-xl p-1 mb-2">
                  {OMEGA_SCALES.map((scale) => (
                    <DropdownMenuItem
                      key={scale.id}
                      onClick={() => setActiveOmega(scale)}
                      className={cn(
                        "flex flex-col items-start gap-1 p-2 cursor-pointer focus:bg-white/5 rounded-lg text-slate-200",
                        activeOmega.id === scale.id ? "bg-[#52DBA9]/10" : ""
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <scale.icon className={cn("w-4 h-4", activeOmega.id === scale.id ? "text-[#52DBA9]" : "text-slate-400")} />
                        <span className={cn("text-sm font-semibold", activeOmega.id === scale.id ? "text-[#52DBA9]" : "text-slate-200")}>{scale.label}</span>
                      </div>
                      <span className="text-[10px] text-slate-400 leading-tight whitespace-normal">{scale.desc}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex items-center gap-2">
              {isGenerating ? (
                <Tooltip>
                  <TooltipTrigger
                    onClick={onStop}
                    className="bg-[#252833] hover:bg-opacity-80 text-white w-9 h-9 flex flex-shrink-0 items-center justify-center rounded-lg transition-all"
                  >
                    <Square className="w-3.5 h-3.5 fill-current text-slate-300" />
                  </TooltipTrigger>
                  <TooltipContent className="bg-[#252833] border-white/5 text-slate-200">Stop generating</TooltipContent>
                </Tooltip>
              ) : (
                <button 
                  onClick={handleSend}
                  disabled={disabled || (!content.trim() && attachments.length === 0)}
                  className="bg-[#52DBA9] hover:bg-[#34d399] disabled:bg-[#252833] disabled:text-slate-500 text-[#13151A] w-9 h-9 rounded-lg transition-all flex items-center justify-center shrink-0"
                >
                  <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 text-center text-[10px] text-slate-500">
          物性论 可能出现偏差，请核对关键信息。
        </div>
      </div>
    </footer>
  );
}
