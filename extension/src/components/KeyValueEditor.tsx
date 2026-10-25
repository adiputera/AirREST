'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { KeyValuePair } from '@/types/api';
import { VariableInput } from './VariableInput';

interface KeyValueEditorProps {
  items: KeyValuePair[];
  onUpdate: (id: string, updates: Partial<KeyValuePair>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export const KeyValueEditor: React.FC<KeyValueEditorProps> = ({
  items,
  onUpdate,
  onAdd,
  onRemove,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
}) => {
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
            <tr>
              <th className="w-10 px-3 py-2 text-center">Use</th>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Value</th>
              <th className="w-10 px-3 py-2 text-center"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-850">
            {(items || []).map((item) => (
              <tr key={item.id} className="group hover:bg-zinc-900/40 transition">
                <td className="px-3 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(e) => onUpdate(item.id, { enabled: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-sky-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-sky-500"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <VariableInput
                    value={item.key}
                    onChange={(key) => onUpdate(item.id, { key })}
                    placeholder={keyPlaceholder}
                    size="sm"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <VariableInput
                    value={item.value}
                    onChange={(value) => onUpdate(item.id, { value })}
                    placeholder={valuePlaceholder}
                    size="sm"
                  />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <button
                    onClick={() => onRemove(item.id)}
                    className="rounded p-1 text-zinc-600 opacity-60 hover:bg-zinc-800 hover:text-rose-400 group-hover:opacity-100 transition"
                    title="Delete row"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition"
      >
        <Plus className="h-3.5 w-3.5 text-sky-400" />
        <span>Add Row</span>
      </button>
    </div>
  );
};
