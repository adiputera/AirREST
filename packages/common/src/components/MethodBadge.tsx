import React from 'react';
import { HttpMethod } from '../types/api';

interface MethodBadgeProps {
  method: HttpMethod;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const METHOD_COLORS: Record<HttpMethod, { text: string; bg: string; border: string }> = {
  GET: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  POST: { text: 'text-sky-400', bg: 'bg-sky-500/15', border: 'border-sky-500/30' },
  PUT: { text: 'text-amber-400', bg: 'bg-amber-500/15', border: 'border-amber-500/30' },
  PATCH: { text: 'text-violet-400', bg: 'bg-violet-500/15', border: 'border-violet-500/30' },
  DELETE: { text: 'text-rose-400', bg: 'bg-rose-500/15', border: 'border-rose-500/30' },
  HEAD: { text: 'text-teal-400', bg: 'bg-teal-500/15', border: 'border-teal-500/30' },
  OPTIONS: { text: 'text-indigo-400', bg: 'bg-indigo-500/15', border: 'border-indigo-500/30' },
};

export const MethodBadge: React.FC<MethodBadgeProps> = ({ method, size = 'sm', className = '' }) => {
  const colors = METHOD_COLORS[method] || METHOD_COLORS.GET;

  const sizeClasses = {
    sm: 'text-[10px] px-1.5 py-0.5 font-bold tracking-wider',
    md: 'text-xs px-2.5 py-1 font-bold tracking-wide',
    lg: 'text-sm px-3.5 py-1.5 font-extrabold tracking-wide',
  };

  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border font-mono uppercase transition-colors ${colors.text} ${colors.bg} ${colors.border} ${sizeClasses[size]} ${className}`}
    >
      {method}
    </span>
  );
};
