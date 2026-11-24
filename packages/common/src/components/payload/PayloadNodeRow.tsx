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
import { VariableInput } from '../VariableInput';

interface PayloadNodeRowProps {
  node: PayloadNode;
  parentType: 'object' | 'list';
  index: number;
  level: number;
  isXmlMode?: boolean;
  parentDisabled?: boolean;
  onUpdate: (updatedNode: PayloadNode) => void;
  onDelete: () => void;
}

export const PayloadNodeRow: React.FC<PayloadNodeRowProps> = ({
  node,
  parentType,
  index,
  level,
  isXmlMode = false,
  parentDisabled = false,
  onUpdate,
  onDelete,
}) => {
  const isContainer = node.type === 'object' || node.type === 'list';
  const isCollapsed = Boolean(node.isCollapsed);
  const isCommented = !node.enabled || Boolean(parentDisabled);

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
  const commentedInputTextClass = isCommented
    ? 'text-tx-muted italic line-through decoration-tx-faint'
    : 'text-tx-primary';

  return (
    <div className="group/row flex flex-col">
      {/* Node Main Row */}
      <div
        data-commented={isCommented ? 'true' : undefined}
        className={`flex flex-wrap items-center gap-2 py-1.5 px-2 rounded-lg transition border ${
          isCommented
            ? 'bg-element/90 border-line/80 hover:bg-hover/80'
            : 'border-transparent hover:bg-hover hover:border-line'
        }`}
        style={{ paddingLeft: `${Math.max(8, indentPx)}px` }}
      >
        {/* Enable / Disable Checkbox */}
        <input
          type="checkbox"
          checked={node.enabled}
          onChange={(e) => onUpdate({ ...node, enabled: e.target.checked })}
          className={`h-3.5 w-3.5 rounded border-line bg-card cursor-pointer shrink-0 ${
            isCommented ? 'text-tx-muted accent-zinc-500' : 'text-sky-500 accent-sky-500'
          }`}
          title={node.enabled ? 'Comment out / disable field' : 'Uncomment / enable field'}
        />

        {/* Explicit Comment Marker (//) for commented fields */}
        {isCommented && (
          <span
            className="rounded border border-line-strong/70 bg-active/80 px-1 py-0.2 font-mono text-[10px] font-semibold text-tx-muted select-none shrink-0"
            title={
              !node.enabled
                ? 'Commented out (excluded from request)'
                : 'Inside commented parent (excluded from request)'
            }
          >
            //
          </span>
        )}

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
          <span
            className={`font-mono text-[11px] rounded px-1.5 py-0.5 border shrink-0 ${
              isCommented
                ? 'bg-active/70 text-tx-muted border-line-strong/70 line-through decoration-tx-faint'
                : 'bg-element text-tx-muted border-line'
            }`}
          >
            [{index}]
          </span>
        ) : (
          <div className="flex items-center gap-1 min-w-[120px] max-w-[200px] flex-1 sm:flex-initial">
            <VariableInput
              value={node.key}
              onChange={(key) => onUpdate({ ...node, key })}
              placeholder="field_name"
              size="sm"
              wrapperClassName="border-transparent bg-transparent focus-within:bg-card focus-within:border-line"
              inputClassName={commentedInputTextClass}
            />
          </div>
        )}

        {/* XML Attribute Toggle (XML mode only) */}
        {isXmlMode && parentType === 'object' && !isContainer && (
          <button
            type="button"
            onClick={() => onUpdate({ ...node, xmlAttribute: !node.xmlAttribute })}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition border shrink-0 ${
              isCommented
                ? 'bg-active/70 text-tx-muted border-line-strong/70'
                : node.xmlAttribute
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
        <PayloadTypeBadge type={node.type} onChange={handleTypeChange} muted={isCommented} />

        {/* Value Editor (based on type) */}
        <div className="flex-1 flex items-center gap-1.5 min-w-[160px]">
          {node.type === 'string' && (
            <VariableInput
              value={node.value ?? ''}
              onChange={(val) => onUpdate({ ...node, value: val })}
              placeholder="String value or {{var}}"
              size="sm"
              wrapperClassName="border-transparent bg-transparent focus-within:bg-card focus-within:border-line"
              inputClassName={commentedInputTextClass}
            />
          )}

          {node.type === 'number' && (
            <VariableInput
              value={node.value ?? ''}
              onChange={(val) => onUpdate({ ...node, value: val })}
              placeholder="0 or {{var}}"
              size="sm"
              wrapperClassName="border-transparent bg-transparent focus-within:bg-card focus-within:border-line"
              inputClassName={commentedInputTextClass}
            />
          )}

          {node.type === 'boolean' && (
            <div className="flex rounded-md border border-line bg-card p-0.5">
              <button
                type="button"
                onClick={() => onUpdate({ ...node, value: 'true' })}
                className={`rounded px-2 py-0.5 text-[11px] font-mono font-medium transition ${
                  node.value === 'true' || node.value === (true as unknown)
                    ? isCommented
                      ? 'bg-active text-tx-muted font-bold line-through decoration-tx-faint'
                      : 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold'
                    : isCommented
                      ? 'text-tx-faint hover:text-tx-muted'
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
                    ? isCommented
                      ? 'bg-active text-tx-muted font-bold line-through decoration-tx-faint'
                      : 'bg-rose-500/20 text-rose-600 dark:text-rose-400 font-bold'
                    : isCommented
                      ? 'text-tx-faint hover:text-tx-muted'
                      : 'text-tx-muted hover:text-tx-primary'
                }`}
              >
                false
              </button>
            </div>
          )}

          {node.type === 'null' && (
            <span
              className={`font-mono text-xs text-tx-muted italic px-2 py-1 ${
                isCommented ? 'line-through decoration-tx-faint' : ''
              }`}
            >
              null
            </span>
          )}

          {node.type === 'date' && (
            <div className="flex items-center gap-1.5 w-full">
              <div className="flex-1 min-w-0">
                <VariableInput
                  value={node.value ?? ''}
                  onChange={(val) => onUpdate({ ...node, value: val })}
                  placeholder="2026-11-02T05:12:00.000Z"
                  size="sm"
                  wrapperClassName="border-transparent bg-transparent focus-within:bg-card focus-within:border-line"
                  inputClassName={commentedInputTextClass}
                />
              </div>
              <DateConfigPopover
                config={node.dateConfig}
                currentValue={node.value}
                onChange={handleDateConfigChange}
                muted={isCommented}
              />
            </div>
          )}

          {node.type === 'object' && (
            <div className="flex items-center gap-2 text-[11px] text-tx-muted font-mono">
              <span className={isCommented ? 'italic line-through decoration-tx-faint' : undefined}>
                {`{ ${(node.children || []).length} field(s) }`}
              </span>
              <button
                type="button"
                onClick={handleAddChild}
                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-sans transition ${
                  isCommented
                    ? 'border-line bg-element text-tx-muted hover:bg-hover hover:text-tx-secondary'
                    : 'border-line bg-card text-tx-secondary hover:bg-hover hover:text-tx-primary'
                }`}
                title="Add field inside this object"
              >
                <Plus className={`h-3 w-3 ${isCommented ? 'text-tx-muted' : 'text-sky-500'}`} />
                <span>Field</span>
              </button>
            </div>
          )}

          {node.type === 'list' && (
            <div className="flex items-center gap-2 text-[11px] text-tx-muted font-mono">
              <span className={isCommented ? 'italic line-through decoration-tx-faint' : undefined}>
                {`[ ${(node.children || []).length} item(s) ]`}
              </span>
              <button
                type="button"
                onClick={handleAddChild}
                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-sans transition ${
                  isCommented
                    ? 'border-line bg-element text-tx-muted hover:bg-hover hover:text-tx-secondary'
                    : 'border-line bg-card text-tx-secondary hover:bg-hover hover:text-tx-primary'
                }`}
                title="Add item inside this list"
              >
                <Plus className={`h-3 w-3 ${isCommented ? 'text-tx-muted' : 'text-indigo-500'}`} />
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
              className={`p-1 rounded text-tx-muted hover:bg-hover transition ${
                isCommented ? 'hover:text-tx-secondary' : 'hover:text-sky-500'
              }`}
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
        <div
          className={`flex flex-col space-y-0.5 mt-0.5 border-l ml-3.5 pl-1.5 ${
            isCommented ? 'border-line-strong/70' : 'border-line/60'
          }`}
        >
          {(node.children || []).map((child, childIdx) => (
            <PayloadNodeRow
              key={child.id || `${node.id}_child_${childIdx}`}
              node={child}
              parentType={node.type as 'object' | 'list'}
              index={childIdx}
              level={level + 1}
              isXmlMode={isXmlMode}
              parentDisabled={isCommented}
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
                className={`hover:underline flex items-center gap-0.5 text-[11px] not-italic font-medium ${
                  isCommented ? 'text-tx-muted' : 'text-sky-500'
                }`}
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
