export type PayloadValueType = 'string' | 'number' | 'boolean' | 'date' | 'list' | 'object' | 'null';

export type DateFormatOption = 
  | 'iso-8601'        // 2026-11-02T05:12:00.000Z
  | 'date-only'       // 2026-11-02
  | 'datetime'        // 2026-11-02 05:12:00
  | 'unix-timestamp'  // 1793574720 (seconds)
  | 'unix-ms'         // 1793574720000 (milliseconds)
  | 'custom';

export interface DateConfig {
  mode: 'static' | 'dynamic_now';
  format: DateFormatOption;
  customPattern?: string;
  value?: string;
}

export interface PayloadNode {
  id: string;
  key: string;
  type: PayloadValueType;
  value?: string;
  dateConfig?: DateConfig;
  children?: PayloadNode[];
  enabled: boolean;
  xmlAttribute?: boolean;
  isCollapsed?: boolean;
}

export interface PayloadBuilderConfig {
  rootType: 'object' | 'list';
  rootKey?: string;            // Root XML element tag name (default: 'request')
  xmlContainerTag?: string;    // XML list wrapper tag name (default: 'items')
  xmlItemTag?: string;         // XML list child element tag name (default: 'item')
  nodes: PayloadNode[];
}
