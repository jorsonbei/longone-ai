import React from 'react';
import type { Locale } from '../lib/locale';

type Props = {
  locale: Locale;
  panelUrl?: string;
};

const COPY: Record<Locale, { eyebrow: string; title: string; subtitle: string; open: string; status: string; note: string }> = {
  en: {
    eyebrow: 'HFCD Energy Trading',
    title: 'AI Paper Trading Sandbox',
    subtitle: 'Runs the local HFCD energy paper-trading panel inside Thing-Nature OS. The module simulates CAISO-style storage arbitrage and records AI/manual trades, PnL, signal lineage, and settlement details.',
    open: 'Open standalone panel',
    status: 'Local panel: http://127.0.0.1:8765/',
    note: 'If the embedded panel is blank, start the local energy paper-trading service first.',
  },
  zh: {
    eyebrow: 'HFCD 能源交易',
    title: 'AI 模拟交易沙盒',
    subtitle: '把本地 HFCD 能源 paper-trading 面板嵌入物性论 OS。该模块模拟 CAISO 风格储能套利，记录 AI/手动交易、盈亏、信号来源和结算明细。',
    open: '独立打开面板',
    status: '本地面板：http://127.0.0.1:8765/',
    note: '如果嵌入面板空白，请先启动本地能源模拟交易服务。',
  },
  fr: {
    eyebrow: 'Trading energie HFCD',
    title: 'Sandbox de paper trading IA',
    subtitle: 'Integre le panneau local HFCD de paper trading energie dans Thing-Nature OS.',
    open: 'Ouvrir le panneau',
    status: 'Panneau local : http://127.0.0.1:8765/',
    note: 'Si le panneau est vide, demarrez d abord le service local.',
  },
  es: {
    eyebrow: 'Trading energia HFCD',
    title: 'Sandbox de paper trading IA',
    subtitle: 'Integra el panel local de paper trading de energia HFCD dentro de Thing-Nature OS.',
    open: 'Abrir panel independiente',
    status: 'Panel local: http://127.0.0.1:8765/',
    note: 'Si el panel aparece vacio, inicia primero el servicio local.',
  },
  vi: {
    eyebrow: 'Giao dich nang luong HFCD',
    title: 'Sandbox paper trading AI',
    subtitle: 'Nhung bang dieu khien paper trading nang luong HFCD cuc bo vao Thing-Nature OS.',
    open: 'Mo bang rieng',
    status: 'Bang cuc bo: http://127.0.0.1:8765/',
    note: 'Neu bang trong, hay khoi dong dich vu cuc bo truoc.',
  },
  de: {
    eyebrow: 'HFCD Energiehandel',
    title: 'KI Paper-Trading Sandbox',
    subtitle: 'Bindet das lokale HFCD Energie-Paper-Trading-Panel in Thing-Nature OS ein.',
    open: 'Eigenes Panel oeffnen',
    status: 'Lokales Panel: http://127.0.0.1:8765/',
    note: 'Falls das Panel leer ist, starten Sie zuerst den lokalen Dienst.',
  },
  ja: {
    eyebrow: 'HFCDエネルギー取引',
    title: 'AIペーパートレード・サンドボックス',
    subtitle: 'ローカルのHFCDエネルギーペーパートレード画面を物性論OSに埋め込みます。',
    open: '単独パネルを開く',
    status: 'ローカルパネル：http://127.0.0.1:8765/',
    note: 'パネルが空の場合は、先にローカルサービスを起動してください。',
  },
};

export default function EnergyTradingPage({ locale, panelUrl = 'http://127.0.0.1:8765/' }: Props) {
  const copy = COPY[locale] || COPY.zh;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b1512] text-slate-100">
      <div className="border-b border-emerald-200/10 bg-[radial-gradient(circle_at_top_left,rgba(52,211,153,0.18),transparent_32rem),linear-gradient(180deg,#10211c_0%,#0b1512_100%)] px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.28em] text-emerald-200/70">{copy.eyebrow}</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-white">{copy.title}</h1>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-emerald-50/62">{copy.subtitle}</p>
          </div>
          <a
            href={panelUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center justify-center rounded-2xl border border-emerald-200/15 bg-emerald-300/12 px-5 py-3 text-sm font-bold text-emerald-100 transition hover:bg-emerald-300/18"
          >
            {copy.open}
          </a>
        </div>
        <div className="mt-4 rounded-2xl border border-emerald-200/10 bg-black/20 px-4 py-3 text-xs leading-5 text-emerald-50/58">
          <span className="font-bold text-emerald-100">{copy.status}</span>
          <span className="mx-2 text-emerald-100/30">|</span>
          <span>{copy.note}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-4">
        <iframe
          title="HFCD Energy AI Paper Trading"
          src={panelUrl}
          className="h-full min-h-[760px] w-full rounded-[28px] border border-emerald-200/15 bg-[#07100d] shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
        />
      </div>
    </div>
  );
}
