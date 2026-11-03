import React from 'react';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  Tag,
} from 'lucide-react';
import { PayloadNode, PayloadValueType, DateConfig } from '../../types/payloadBuilder';
import { PayloadTypeBadge } from './PayloadTypeBadge';
import { DateConfigPopover } from './DateConfigPopover';
import { generateNodeId, createDefaultPayloadNode } from '../../lib/payloadCompiler';

interface PayloadNodeRowProps {
  node: PayloadNode;
  parentType: 'object' | 'list';
  index: number;
  level: number;
  isXmlMode?: boolean;
  onUpdate: (updatedNode: PayloadNode) => void;
  onDelete: () => void;
}

export const PayloadNodeRow: React.FC<PayloadNodeRowProps> = ({
  node,
  parentType,
  index,
  level,
  isXmlMode = false,
  onUpdate,
  onDelete,
}) => {
  const isContainer = node.type === 'object' || node.type === 'list';
  const isCollapsed = Boolean(node.isCollapsed);

  const handleTypeChange = (newType: PayloadValueType) => {
    let updatedChildren = node.children;
    let updatedValue = node.value;

    if (newType === 'object') {
      updatedChildren = updatedChildren && updatedChildren.length > 0
        ? updatedChildren
        : [createDefaultPayloadNode({ key: 'childKey', type: 'string', value: '' })];
      updatedValue = undefined;
    } else if (newType === 'list') {
      updatedChildren = updatedChildren && updatedChildren.length > 0
        ? updatedChildren
        : [createDefaultPayloadNode({ key: '', type: 'string', value: '' })];
      updatedValue = undefined;
    } else if (newType === 'boolean') {
      updatedValue = node.value === 'false' ? 'false' : 'true';
    } else if (newType === 'number') {
      updatedValue = node.value && !isNaN(Number(node.value)) ? node.value : '0';
    } else if (newType === 'null') {
      updatedValue = '';
    } else if (newType === 'date') {
      updatedValue = node.value || new Date().toISOString();
    }

    onUpdate({
      ...node,
      type: newType,
      value: updatedValue,
      children: updatedChildren,
      isCollapsed: false,
    });
  };

  const handleAddChild = () => {
    const isParentList = node.type === 'list';
    const newChild = createDefaultPayloadNode({
      key: isParentList ? '' : `field_${(node.children || []).length + 1}`,
      type: 'string',
      value: '',
    });

    onUpdate({
      ...node,
      children: [...(node.children || []), newChild],
      isCollapsed: false,
    });
  };

  const handleUpdateChild = (childId: string, updatedChild: PayloadNode) => {
    const updatedChildren = (node.children || []).map((c) =>
      c.id === childId ? updatedChild : c
    );
    onUpdate({
      ...node,
      children: updatedChildren,
    });
  };

  const handleDeleteChild = (childId: string) => {
    const updatedChildren = (node.children || []).filter((c) => c.id !== childId);
    onUpdate({
      ...node,
      children: updatedChildren,
    });
  };

  const handleDateConfigChange = (newConfig: DateConfig, newValue: string) => {
    onUpdate({
      ...node,
      dateConfig: newConfig,
      value: newValue,
    });
  };

  const indentPx = Math.min(level * 20, 160);

  return (
    <div className="group/row flex flex-col">
      {/* Node Main Row */}
      <div
        className={`flex flex-wrap items-center gap-2 py-1.5 px-2 rounded-lg transition border border-transparent ${
          !node.enabled ? 'opacity-40 bg-element/20' : 'hover:bg-hover hover:border-line'
        }`}
        style={{ paddingLeft: `${Math.max(8, indentPx)}px` }}
      >
        {/* Enable / Disable Checkbox */}
        <input
          type="checkbox"
          checked={node.enabled}
          onChange={(e) => onUpdate({ ...node, enabled: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-line bg-card text-sky-500 accent-sky-500 cursor-pointer shrink-0"
          title={node.enabled ? 'Disable field' : 'Enable field'}
        />

        {/* Expand / Collapse Button for containers */}
        {isContainer ? (
          <button
            type="button"
            onClick={() => onUpdate({ ...node, isCollapsed: !isCollapsed })}
            className="p-0.5 rounded text-tx-muted hover:text-tx-primary hover:bg-element transition shrink-0"
            title={isCollapsed ? 'Expand items' : 'Collapse items'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Key Input (for Objects) or Index Badge (for Lists) */}
        {parentType === 'list' ? (
          <span className="font-mono text-[11px] text-tx-muted rounded bg-element px-1.5 py-0.5 border border-line shrink-0">
            [{index}]
          </span>
        ) : (
          <div className="flex items-center gap-1 min-w-[120px] max-w-[200px] flex-1 sm:flex-initial">
            <input
              type="text"
              value={node.key}
              onChange={(e) => onUpdate({ ...node, key: e.target.value })}
              placeholder="field_name"
              className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-tx-primary placeholder-tx-faint focus:bg-card focus:outline-none focus:ring-1 focus:ring-sky-500/50 border border-transparent focus:border-line"
            />
          </div>
        )}

        {/* XML Attribute Toggle (XML mode only) */}
        {isXmlMode && parentType === 'object' && !isContainer && (
          <button
            type="button"
            onClick={() => onUpdate({ ...node, xmlAttribute: !node.xmlAttribute })}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition border shrink-0 ${
              node.xmlAttribute
                ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/40'
                : 'text-tx-muted border-line hover:text-tx-primary'
            }`}
            title="Toggle as XML attribute in opening tag"
          >
            <Tag className="h-2.5 w-2.5" />
            <span>Attr</span>
          </button>
        )}

        {/* Type Badge Dropdown */}
        <PayloadTypeBadge type={node.type} onChange={handleTypeChange} />

        {/* Value Editor (based on type) */}
        <div className="flex-1 flex items-center gap-1.5 min-w-[160px]">
          {node.type === 'string' && (
            <input
              type="text"
              value={node.value ?? ''}
              onChange={(e) => onUpdate({ ...node, value: e.target.value })}
              placeholder="String value or {{var}}"
              className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-tx-primary placeholder-tx-faint focus:bg-card focus:outline-none focus:ring-1 focus:ring-sky-500/50 border border-transparent focus:border-line"
            />
          )}

          {node.type === 'number' && (
            <input
              type="text"
              value={node.value ?? ''}
              onChange={(e) => onUpdate({ ...node, value: e.target.value })}
              placeholder="0 or {{var}}"
              className="w-full rounded bg-transparent px-2 py-1 font-mono text-xs text-tx-primary placeholder-tx-faint focus:bg-card focus:outline-none focus:ring-1 focus:ring-amber-500/50 border border-transparent focus:border-line"
            />
          )}

          {node.type === 'boolean' && (
            <div className="flex rounded-md border border-line bg-card p-0.5">
              <button
                type="button"
                onClick={() => onUpdate({ ...node, value: 'true' })}
                className={`rounded px-2 py-0.5 text-[11px] font-mono font-medium transition ${
                  node.value === 'true' || node.value === (true as unknown)
                    ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold'
                    : 'text-tx-muted hover:text-tx-primary'
                }`}
              >
                true
              </button>
              <button
                type="button"
                onClick={() => onUpdate({ ...node, value: 'false' })}
                className={`rounded px-2 py-0.5 text-[11px] font-mono font-medium transition ${
                  node.value === 'false' || node.value === (false as unknown)
                    ? 'bg-rose-500/20 text-rose-600 dark:text-rose-400 font-bold'
                    : 'text-tx-muted hover:text-tx-primary'
                }`}
              >
                false
              </button>
            </div>
          )}

          {node.type === 'null' && (
            <span className="font-mono text-xs text-tx-muted italic px-2 py-1">
              null
            </span>
          )}

          {node.type === 'date' && (
            <div className="flex items-center gap-1.5 w-full">
              <input
                type="text"
                value={node.value ?? ''}
                onChange={(e) => onUpdate({ ...node, value: e.target.value })}
                placeholder="2026-11-02T05:12:00.000Z"
                className="flex-1 rounded bg-transparent px-2 py-1 font-mono text-xs text-tx-primary placeholder-tx-faint focus:bg-card focus:outline-none focus:ring-1 focus:ring-purple-500/50 border border-transparent focus:border-line"
              />
              <DateConfigPopover
                config={node.dateConfig}
                currentValue={node.value}
                onChange={handleDateConfigChange}
              />
            </div>
          )}

          {node.type === 'object' && (
            <div className="flex items-center gap-2 text-[11px] text-tx-muted font-mono">
              <span>{`{ ${(node.children || []).length} field(s) }`}</span>
              <button
                type="button"
                onClick={handleAddChild}
                className="flex items-center gap-1 rounded border border-line bg-card px-1.5 py-0.5 text-[11px] font-sans text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                title="Add field inside this object"
              >
                <Plus className="h-3 w-3 text-sky-500" />
                <span>Field</span>
              </button>
            </div>
          )}

          {node.type === 'list' && (
            <div className="flex items-center gap-2 text-[11px] text-tx-muted font-mono">
              <span>{`[ ${(node.children || []).length} item(s) ]`}</span>
              <button
                type="button"
                onClick={handleAddChild}
                className="flex items-center gap-1 rounded border border-line bg-card px-1.5 py-0.5 text-[11px] font-sans text-tx-secondary hover:bg-hover hover:text-tx-primary transition"
                title="Add item inside this list"
              >
                <Plus className="h-3 w-3 text-indigo-500" />
                <span>Item</span>
              </button>
            </div>
          )}
        </div>

        {/* Row Action Buttons */}
        <div className="flex items-center gap-1 shrink-0 ml-auto opacity-70 group-hover/row:opacity-100 transition">
          {isContainer && (
            <button
              type="button"
              onClick={handleAddChild}
              className="p-1 rounded text-tx-muted hover:bg-hover hover:text-sky-500 transition"
              title={node.type === 'object' ? 'Add sub-field' : 'Add list item'}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={onDelete}
            className="p-1 rounded text-tx-muted hover:bg-hover hover:text-rose-500 transition"
            title="Delete this node"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Recursive Children Rendering */}
      {isContainer && !isCollapsed && (
        <div className="flex flex-col space-y-0.5 mt-0.5 border-l border-line/60 ml-3.5 pl-1.5">
          {(node.children || []).map((child, childIdx) => (
            <PayloadNodeRow
              key={child.id || `${node.id}_child_${childIdx}`}
              node={child}
              parentType={node.type as 'object' | 'list'}
              index={childIdx}
              level={level + 1}
              isXmlMode={isXmlMode}
              onUpdate={(updated) => handleUpdateChild(child.id, updated)}
              onDelete={() => handleDeleteChild(child.id)}
            />
          ))}

          {(node.children || []).length === 0 && (
            <div
              className="py-1 px-3 text-[11px] text-tx-muted italic flex items-center gap-2"
              style={{ paddingLeft: `${indentPx + 16}px` }}
            >
              <span>Empty {node.type === 'object' ? 'object' : 'list'}.</span>
              <button
                type="button"
                onClick={handleAddChild}
                className="text-sky-500 hover:underline flex items-center gap-0.5 text-[11px] not-italic font-medium"
              >
                <Plus className="h-3 w-3" />
                <span>Add first item</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
