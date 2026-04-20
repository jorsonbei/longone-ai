import React from 'react';
import { cn } from '@/lib/utils';

interface ThingNatureBrandProps {
  compact?: boolean;
  className?: string;
  subtitle?: string;
}

export function ThingNatureBrand({ compact = false, className, subtitle = 'THING NATURE OS' }: ThingNatureBrandProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div className={cn(
        'thingnature-logo relative overflow-hidden rounded-2xl border border-white/10 bg-[#10131d] shadow-[0_20px_60px_rgba(42,228,181,0.18)]',
        compact ? 'h-6 w-6 rounded-xl' : 'h-14 w-14'
      )}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_24%,rgba(120,248,224,0.95),transparent_38%),radial-gradient(circle_at_78%_76%,rgba(84,119,255,0.95),transparent_46%),linear-gradient(145deg,#07111b,#18243d_55%,#0e1320)]" />
        <svg
          viewBox="0 0 64 64"
          className="absolute inset-0 h-full w-full"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M17 47C24 35 33 28 47 17" stroke="rgba(174,255,239,0.95)" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M18 18C30 23 37 31 45 46" stroke="rgba(118,150,255,0.95)" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M18 18C25 29 25 38 17 47" stroke="rgba(98,242,206,0.35)" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="18" cy="18" r="4.5" fill="#7BFFE1" />
          <circle cx="17" cy="47" r="5.5" fill="#4EE0B7" />
          <circle cx="47" cy="17" r="5" fill="#87A4FF" />
          <circle cx="45" cy="46" r="5.5" fill="#DCE6FF" />
        </svg>
      </div>

      <div className="min-w-0">
        <div className={cn(
          'font-black tracking-tight text-white',
          compact ? 'text-base leading-none' : 'text-2xl leading-none'
        )}>
          物性论
        </div>
        <div className={cn(
          'mt-1 text-[10px] uppercase tracking-[0.28em] text-[#7ee8c5]/80',
          compact ? 'hidden' : 'block'
        )}>
          {subtitle}
        </div>
      </div>
    </div>
  );
}
