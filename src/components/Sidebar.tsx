import React from 'react';
import { Plus, Trash2, Edit2, Check, X, Menu, User, Settings, HelpCircle, LogOut, Globe, Shield, Languages, Activity } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatSession } from '../types';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useAuth } from '../lib/AuthContext';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ThingNatureBrand } from './ThingNatureBrand';
import type { UiText } from '../content/uiText';
import { LOCALE_OPTIONS, type Locale } from '../lib/locale';

interface SidebarProps {
  chats: ChatSession[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onOpenOfficialSite: () => void;
  onOpenHFCD: () => void;
  onOpenAdmin: () => void;
  canAccessAdmin: boolean;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onOpenSettings: () => void;
  onLogOut: () => void;
  ui: UiText;
  locale: Locale;
  onChangeLocale: (locale: Locale) => void;
}

function SidebarContent({ chats, activeChatId, onSelectChat, onNewChat, onOpenOfficialSite, onOpenHFCD, onOpenAdmin, canAccessAdmin, onDeleteChat, onRenameChat, onOpenSettings, onLogOut, ui, locale, onChangeLocale }: SidebarProps) {
  const { user } = useAuth();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');

  const languageLabelByLocale: Record<Locale, string> = {
    en: 'Language',
    zh: '语言',
    fr: 'Langue',
    es: 'Idioma',
    vi: 'Ngôn ngữ',
    de: 'Sprache',
    ja: '言語',
  };
  const currentLocaleOption = LOCALE_OPTIONS.find((option) => option.value === locale) || LOCALE_OPTIONS[0];
  const hfcdLabelByLocale: Record<Locale, { title: string; subtitle: string }> = {
    en: { title: 'Risk Diagnosis', subtitle: 'Upload data, get repair actions' },
    zh: { title: '芯片、材料、能源', subtitle: '研发增强模型' },
    fr: { title: 'Diagnostic risque', subtitle: 'Importez les donnees, obtenez les actions' },
    es: { title: 'Diagnostico de riesgo', subtitle: 'Sube datos y recibe acciones' },
    vi: { title: 'Chan doan rui ro', subtitle: 'Tai du lieu, nhan cach sua' },
    de: { title: 'Risikodiagnose', subtitle: 'Daten hochladen, Massnahmen erhalten' },
    ja: { title: 'リスク診断', subtitle: 'データから修復案を生成' },
  };

  const handleEdit = (chat: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(chat.id);
    setEditTitle(chat.title);
  };

  const handleSaveEdit = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (editTitle.trim()) {
      onRenameChat(id, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(ui.sidebar.deleteConfirm)) {
      onDeleteChat(id);
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-[linear-gradient(180deg,#151823_0%,#12141d_100%)] text-white">
      {/* Brand & Logo */}
      <div className="p-6 pb-3 shrink-0">
        <ThingNatureBrand subtitle={ui.brand.sidebarSubtitle} />
      </div>

      <div className="px-4 pt-4 pb-3 shrink-0">
        <button onClick={onOpenOfficialSite} className="mb-3 w-full flex items-center gap-3 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(82,219,169,0.12),rgba(82,219,169,0.04))] px-4 py-3 text-left transition-colors hover:bg-[linear-gradient(180deg,rgba(82,219,169,0.18),rgba(82,219,169,0.08))]">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#52DBA9]/15 text-[#7ef8d2] flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            <Globe className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-slate-100">{ui.sidebar.officialSiteTitle}</span>
            <span className="text-[11px] text-slate-500">{ui.sidebar.officialSiteSubtitle}</span>
          </div>
        </button>
        <button onClick={onOpenHFCD} className="mb-3 w-full flex items-center gap-3 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(251,191,36,0.12),rgba(251,191,36,0.04))] px-4 py-3 text-left transition-colors hover:bg-[linear-gradient(180deg,rgba(251,191,36,0.18),rgba(251,191,36,0.08))]">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-300/15 text-amber-200 flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            <Activity className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-slate-100">{hfcdLabelByLocale[locale].title}</span>
            <span className="text-[11px] text-slate-500">{hfcdLabelByLocale[locale].subtitle}</span>
          </div>
        </button>
        {canAccessAdmin ? (
          <button onClick={onOpenAdmin} className="mb-3 w-full flex items-center gap-3 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(99,125,255,0.12),rgba(99,125,255,0.04))] px-4 py-3 text-left transition-colors hover:bg-[linear-gradient(180deg,rgba(99,125,255,0.18),rgba(99,125,255,0.08))]">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#637dff]/15 text-[#a8b5ff] flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <Shield className="w-3.5 h-3.5" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-slate-100">{ui.sidebar.adminTitle}</span>
              <span className="text-[11px] text-slate-500">{ui.sidebar.adminSubtitle}</span>
            </div>
          </button>
        ) : null}
        <button onClick={onNewChat} className="w-full flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.07]">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#52DBA9]/15 text-[#7ef8d2] flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
             <Plus className="w-3.5 h-3.5" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-slate-100">{ui.sidebar.newChatTitle}</span>
            <span className="text-[11px] text-slate-500">{ui.sidebar.newChatSubtitle}</span>
          </div>
        </button>
      </div>
      
      <ScrollArea className="flex-1 px-3">
        <div className="flex flex-col gap-1 pb-4">
          <div className="px-3 py-3 text-[10px] font-bold uppercase tracking-[0.28em] text-slate-500">
            {ui.sidebar.chatHistory}
          </div>
          {chats.map(chat => (
            <div 
              key={chat.id}
              onClick={() => onSelectChat(chat.id)}
              className={cn(
                "group relative flex items-center gap-2 rounded-2xl px-3 py-3 cursor-pointer transition-colors text-sm truncate border",
                activeChatId === chat.id 
                  ? "border-white/10 bg-white/[0.06] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" 
                  : "border-transparent text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              )}
            >
              {editingId === chat.id ? (
                <div className="flex-1 flex items-center gap-1 min-w-0">
                  <input 
                    autoFocus
                    className="flex-1 bg-transparent border-b border-white/30 text-sm focus:outline-none focus:border-white/70 py-0.5 min-w-0"
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveEdit(chat.id, e as any);
                      if (e.key === 'Escape') handleCancelEdit(e as any);
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                  <button onClick={(e) => handleSaveEdit(chat.id, e)} className="p-1 hover:text-[#52DBA9]">
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={handleCancelEdit} className="p-1 hover:text-red-400">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex-1 flex flex-col min-w-0">
                  <span className="text-sm truncate pr-8">{chat.title}</span>
                </div>
              )}

              {editingId !== chat.id && (
                <div className={cn(
                  "absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-transparent",
                  activeChatId === chat.id ? "opacity-100" : ""
                )}>
                  <button 
                    onClick={(e) => handleEdit(chat, e)} 
                    className="p-1 text-white/50 hover:text-white rounded-md"
                    title={ui.sidebar.rename}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button 
                    onClick={(e) => handleDelete(chat.id, e)} 
                    className="p-1 text-white/50 hover:text-red-400 rounded-md"
                    title={ui.sidebar.delete}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
          {chats.length === 0 && (
            <div className="text-sm text-slate-500 text-center py-4">
              {ui.sidebar.noRecentChats}
            </div>
          )}
        </div>
      </ScrollArea>
      
      {/* Footer Profile */}
      <div className="p-4 flex flex-col gap-3 shrink-0 bg-transparent">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-300">
            <Languages className="h-4 w-4 flex-shrink-0 text-slate-500" />
            <span className="truncate">{languageLabelByLocale[locale]}</span>
          </div>
          <Select value={locale} onValueChange={(value) => onChangeLocale(value as Locale)}>
            <SelectTrigger className="h-10 w-[132px] rounded-xl border-white/10 bg-[#171a24] px-3 text-slate-100 shadow-none">
              <SelectValue>{currentLocaleOption.label}</SelectValue>
            </SelectTrigger>
            <SelectContent className="border-white/10 bg-[#1C1E26] text-slate-100">
              {LOCALE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value} className="focus:bg-white/10">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger className="w-full focus:outline-none">
            <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-white">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5">
                  <User className="w-4 h-4 flex-shrink-0" />
                </div>
                <div className="min-w-0 text-left">
                  <div className="truncate text-sm font-medium text-slate-200">{user?.displayName || ui.sidebar.accountFallback}</div>
                  <div className="truncate text-[11px] text-slate-500">{user?.email || ui.sidebar.accountHelp}</div>
                </div>
              </div>
              <HelpCircle className="w-4 h-4 flex-shrink-0 text-slate-500" />
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent 
            side="top" 
            align="start" 
            className="w-56 bg-[#252833] border-white/10 text-white shadow-xl shadow-black/50 mb-2 rounded-xl"
          >
            <DropdownMenuItem className="gap-2 cursor-pointer focus:bg-white/10 text-gray-300 py-2.5">
              <HelpCircle className="w-4 h-4" />
              <span>{ui.sidebar.helpCenter}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem onClick={onLogOut} className="gap-2 cursor-pointer focus:bg-white/10 focus:text-red-400 text-gray-300 py-2.5">
              <LogOut className="w-4 h-4" />
              <span>{ui.sidebar.signOut}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={onOpenSettings}
          className="mt-1 flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-white"
        >
          <Settings className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium">{ui.sidebar.settings}</span>
        </button>
      </div>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  // Desktop fixed sidebar, Mobile sheet
  return (
    <>
      <div className="hidden md:flex w-64 flex-col h-full shrink-0 border-r border-[#252833]">
        <SidebarContent {...props} />
      </div>
      
      <div className="md:hidden absolute top-3 left-4 z-50">
        <Sheet>
          <SheetTrigger className="md:hidden inline-flex items-center justify-center rounded-md text-sm font-medium hover:bg-white/10 h-9 w-9 text-slate-300">
            <Menu className="w-6 h-6" />
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-72 bg-[#1C1E26] border-[#252833]">
            <SidebarContent {...props} />
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
