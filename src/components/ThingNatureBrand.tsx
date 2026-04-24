import React from 'react';
import { cn } from '@/lib/utils';

interface ThingNatureMarkProps {
  className?: string;
  compact?: boolean;
}

interface ThingNatureBrandProps {
  compact?: boolean;
  className?: string;
  subtitle?: string;
}

export function ThingNatureMark({ className, compact = false }: ThingNatureMarkProps) {
  return (
    <div
      className={cn(
        'thingnature-logo relative overflow-hidden border border-white/10 bg-[#091019] shadow-[0_20px_60px_rgba(30,225,179,0.18)]',
        compact ? 'h-6 w-6 rounded-xl' : 'h-14 w-14 rounded-[1.35rem]',
        className,
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_22%,rgba(131,255,228,0.28),transparent_32%),radial-gradient(circle_at_74%_78%,rgba(102,130,255,0.28),transparent_36%),linear-gradient(155deg,#07111b_0%,#102338_48%,#0b1423_100%)]" />
      <svg
        viewBox="0 0 64 64"
        className="absolute inset-0 h-full w-full"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="thingnature-axis" x1="18" y1="52" x2="46" y2="12" gradientUnits="userSpaceOnUse">
            <stop stopColor="#5EF0C2" />
            <stop offset="1" stopColor="#8EA4FF" />
          </linearGradient>
          <linearGradient id="thingnature-orbit" x1="15" y1="32" x2="49" y2="32" gradientUnits="userSpaceOnUse">
            <stop stopColor="rgba(126,248,210,0.88)" />
            <stop offset="1" stopColor="rgba(129,152,255,0.88)" />
          </linearGradient>
        </defs>
        <ellipse cx="32" cy="32" rx="19" ry="11.5" stroke="url(#thingnature-orbit)" strokeWidth="2.6" opacity="0.95" />
        <ellipse cx="32" cy="32" rx="12" ry="19" stroke="rgba(146,233,255,0.26)" strokeWidth="1.9" transform="rotate(32 32 32)" />
        <path d="M22 47.5L41.5 16.5" stroke="url(#thingnature-axis)" strokeWidth="3.3" strokeLinecap="round" />
        <circle cx="32" cy="32" r="6.8" fill="#DDFBFF" />
        <circle cx="32" cy="32" r="3.8" fill="#7EF8D2" />
        <circle cx="20.5" cy="23.5" r="3.2" fill="#7EF8D2" />
        <circle cx="44.5" cy="40.5" r="3.2" fill="#93A8FF" />
        <circle cx="22" cy="47.5" r="4.2" fill="#39DFA9" />
        <circle cx="41.5" cy="16.5" r="3.6" fill="#B5C7FF" />
      </svg>
    </div>
  );
}

export function ThingNatureBrand({ compact = false, className, subtitle = 'THING NATURE OS' }: ThingNatureBrandProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <ThingNatureMark compact={compact} />

      <div className="min-w-0">
        <div
          className={cn(
            'font-black tracking-tight text-white',
            compact ? 'text-base leading-none' : 'text-2xl leading-none',
          )}
        >
          物性论
        </div>
        <div
          className={cn(
            'mt-1 text-[10px] uppercase tracking-[0.28em] text-[#7ee8c5]/80',
            compact ? 'hidden' : 'block',
          )}
        >
          {subtitle}
        </div>
      </div>
    </div>
  );
}
