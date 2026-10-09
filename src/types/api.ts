export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface KeyValuePair {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

export interface FormDataItem {
  id: string;
  key: string;
  type: 'text' | 'file';
  value: string; // text value or file name display
  file?: File;
  enabled: boolean;
}

export type BodyType = 'none' | 'json' | 'raw' | 'x-www-form-urlencoded' | 'form-data';

export interface AuthConfig {
  type: 'none' | 'bearer' | 'basic' | 'apikey';
  bearerToken?: string;
  basicUsername?: string;
  basicPassword?: string;
  apiKeyKey?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
}

export interface ApiRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValuePair[];
  headers: KeyValuePair[];
  auth: AuthConfig;
  bodyType: BodyType;
  bodyContent: string;
  bodyFormData?: FormDataItem[];
  preRequestScript?: string;
  postResponseScript?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  headers: Record<string, string>;
  data: string;
  isError?: boolean;
  errorDetail?: string;
  scriptError?: string;
  updatedEnvVars?: string[];
  timestamp: number;
}

export interface CollectionItem {
  id: string;
  name: string;
  type: 'folder' | 'request';
  request?: ApiRequest;
  items?: CollectionItem[];
}

export interface Collection {
  id: string;
  name: string;
  description?: string;
  items: CollectionItem[];
  createdAt: number;
  updatedAt: number;
}

export interface HistoryItem {
  id: string;
  request: ApiRequest;
  response?: ApiResponse;
  timestamp: number;
}

export interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
  createdAt: number;
  updatedAt: number;
}
