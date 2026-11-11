import { getQuickJS, QuickJSWASMModule, QuickJSHandle } from 'quickjs-emscripten';
import {
  ScriptInput,
  ScriptResult,
  SCRIPT_LIMITS,
  validateScriptInput,
  validateScriptOutput,
  getUtf8ByteLength,
} from '@airrest/common/protocol';
import { CRYPTO_JS_SOURCE } from '@airrest/common/crypto';

let quickJsModulePromise: Promise<QuickJSWASMModule> | null = null;

const INTERNAL_SANDBOX_PARAMETERS = [
  'pm',
  'postman',
  'response',
  'responseBody',
  'responseCode',
  'responseTime',
  'responseHeaders',
  'tests',
] as const;

function describeInternalParameterRedefinition(errorMessage: string, script: string): string {
  if (!/(?:invalid redefinition of parameter name|(?:identifier|parameter).*?(?:already been declared|redeclared)|redeclaration)/i.test(errorMessage)) {
    return errorMessage;
  }

  for (const parameter of INTERNAL_SANDBOX_PARAMETERS) {
    const declarationPattern = new RegExp(`\\b(?:const|let|class|function)\\s+${parameter}\\b`);
    if (declarationPattern.test(script)) {
      return `${errorMessage}\n\nParameter '${parameter}' is already used by the internal sandbox. Rename your local variable; for example, use 'responseJson' instead of 'response'.`;
    }
  }

  return errorMessage;
}

export function getCachedQuickJS(): Promise<QuickJSWASMModule> {
  if (!quickJsModulePromise) {
    quickJsModulePromise = getQuickJS().catch((err) => {
      quickJsModulePromise = null;
      throw err;
    });
  }
  return quickJsModulePromise;
}

/**
 * Runs a script in a completely fresh, isolated QuickJS WASM runtime and context.
 * Enforces resource bounds, execution timeouts, safe console stubs,
 * captured serialization primitives, and boundary output validation.
 */
export async function runQuickJsGuest(
  input: ScriptInput,
  options?: { timeoutMs?: number; signal?: AbortSignal; onEvalStart?: () => void }
): Promise<ScriptResult> {
  // 1. Validate input limits before spending WASM resources
  const inputValidation = validateScriptInput(input);
  if (!inputValidation.valid) {
    return {
      success: false,
      error: inputValidation.error || 'Input validation failed.',
      environment: { ...(input.environment || {}) },
      variables: { ...(input.variables || {}) },
    };
  }

  if (!input.script) {
    return {
      success: true,
      environment: { ...(input.environment || {}) },
      variables: { ...(input.variables || {}) },
    };
  }

  if (options?.signal?.aborted) {
    return {
      success: false,
      error: 'Script execution was aborted before evaluation.',
      environment: { ...(input.environment || {}) },
      variables: { ...(input.variables || {}) },
    };
  }

  const timeoutMs = options?.timeoutMs ?? SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS;
  const qjs = await getCachedQuickJS();
  const runtime = qjs.newRuntime();

  // Resource budgets: 64 MiB memory limit, 512 KiB max stack
  runtime.setMemoryLimit(SCRIPT_LIMITS.MAX_HEAP_BYTES);
  runtime.setMaxStackSize(SCRIPT_LIMITS.MAX_STACK_BYTES);

  // Execution deadline interrupt
  let deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let abortedBySignal = false;
  runtime.setInterruptHandler(() => {
    if (options?.signal?.aborted) {
      abortedBySignal = true;
      return true;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const context = runtime.newContext();
  let errorFormatterFn: QuickJSHandle | null = null;

  try {
    // Guest preamble sets up safe environment and captures pristine primitives
    const guestPreamble = `
      (function() {
        // Capture pristine global primitives before user script runs
        const _Reflect_apply = Reflect.apply;
        const _JSON_stringify = JSON.stringify;
        const _JSON_parse = JSON.parse;
        const _Object_assign = Object.assign;
        const _Object_keys = Object.keys;
        const _Object_prototype_hasOwnProperty = Object.prototype.hasOwnProperty;
        const _Object_getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
        const _Array_isArray = Array.isArray;
        const _String = String;
        const _String_prototype_charCodeAt = String.prototype.charCodeAt;
        const _String_prototype_slice = String.prototype.slice;
        const _String_prototype_toLowerCase = String.prototype.toLowerCase;
        const _String_prototype_toUpperCase = String.prototype.toUpperCase;
        const _String_prototype_trim = String.prototype.trim;
        const _Math_max = Math.max;

        // Stub console to prevent ReferenceError while avoiding unvetted host output
        const _noop = function() {};
        globalThis.console = {
          log: _noop,
          info: _noop,
          warn: _noop,
          error: _noop,
          debug: _noop
        };

        function isForbiddenKey(k) {
          return k === '__proto__' || k === 'constructor' || k === 'prototype';
        }

        function _normalizeGuestError(err) {
          try {
            if (typeof err === 'string') {
              return err;
            }
            if (err && typeof err === 'object') {
              try {
                const desc = _Reflect_apply(_Object_getOwnPropertyDescriptor, Object, [err, 'message']);
                if (desc && typeof desc.value === 'string') {
                  return desc.value;
                }
              } catch {}
              try {
                if (typeof err.message === 'string') {
                  return err.message;
                }
              } catch {
                return 'Script execution threw an error with an unreadable message.';
              }
              try {
                return _String(err);
              } catch {
                return 'Script execution threw an uncoercible error object.';
              }
            }
            try {
              return _String(err);
            } catch {
              return 'Script execution threw an uncoercible value.';
            }
          } catch {
            return 'Script execution failed.';
          }
        }

        function _getUtf8ByteLength(str) {
          if (!str) return 0;
          let bytes = 0;
          const len = str.length;
          for (let i = 0; i < len; i++) {
            const code = _Reflect_apply(_String_prototype_charCodeAt, str, [i]);
            if (code <= 0x7f) {
              bytes += 1;
            } else if (code <= 0x7ff) {
              bytes += 2;
            } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
              const next = _Reflect_apply(_String_prototype_charCodeAt, str, [i + 1]);
              if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
              } else {
                bytes += 3;
              }
            } else {
              bytes += 3;
            }
          }
          return bytes;
        }

        function _truncateUtf8(str, maxBytes) {
          if (_getUtf8ByteLength(str) <= maxBytes) return str;
          const suffix = '... (truncated)';
          const suffixBytes = _getUtf8ByteLength(suffix);
          const targetBytes = _Math_max(0, maxBytes - suffixBytes);
          let currentBytes = 0;
          let cutIndex = 0;
          const len = str.length;
          for (let i = 0; i < len; i++) {
            const code = _Reflect_apply(_String_prototype_charCodeAt, str, [i]);
            let charBytes = 1;
            let isSurrogatePair = false;
            if (code > 0x7f) {
              if (code <= 0x7ff) {
                charBytes = 2;
              } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
                const next = _Reflect_apply(_String_prototype_charCodeAt, str, [i + 1]);
                if (next >= 0xdc00 && next <= 0xdfff) {
                  charBytes = 4;
                  isSurrogatePair = true;
                } else {
                  charBytes = 3;
                }
              } else {
                charBytes = 3;
              }
            }
            if (currentBytes + charBytes > targetBytes) break;
            currentBytes += charBytes;
            cutIndex = isSurrogatePair ? i + 2 : i + 1;
            if (isSurrogatePair) i++;
          }
          return _Reflect_apply(_String_prototype_slice, str, [0, cutIndex]) + suffix;
        }

        // Safe map serialization that NEVER evaluates guest toJSON, join, push or prototype hooks
        function safeSerializeMap(map) {
          if (!map || typeof map !== 'object' || _Array_isArray(map)) {
            return '{}';
          }
          const keys = _Object_keys(map);
          let result = '{';
          let first = true;
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (isForbiddenKey(k)) continue;
            const v = _String(map[k]);
            if (!first) {
              result += ',';
            }
            result += _JSON_stringify(_String(k)) + ':' + _JSON_stringify(v);
            first = false;
          }
          result += '}';
          return result;
        }

        function safeSerializeMutatedReq(mut) {
          if (!mut || typeof mut !== 'object') return 'null';
          const urlJson = _JSON_stringify(_String(mut.url || ''));
          const qList = _Array_isArray(mut.queryParams) ? mut.queryParams : [];
          let qJson = '[';
          for (let i = 0; i < qList.length; i++) {
            if (i > 0) qJson += ',';
            const item = qList[i];
            const k = item && item.key !== undefined ? _String(item.key) : '';
            const v = item && item.value !== undefined ? _String(item.value) : '';
            qJson += '{"key":' + _JSON_stringify(k) + ',"value":' + _JSON_stringify(v) + '}';
          }
          qJson += ']';

          const hList = _Array_isArray(mut.headers) ? mut.headers : [];
          let hJson = '[';
          for (let i = 0; i < hList.length; i++) {
            if (i > 0) hJson += ',';
            const item = hList[i];
            const k = item && item.key !== undefined ? _String(item.key) : '';
            const v = item && item.value !== undefined ? _String(item.value) : '';
            hJson += '{"key":' + _JSON_stringify(k) + ',"value":' + _JSON_stringify(v) + '}';
          }
          hJson += ']';

          return '{"url":' + urlJson + ',"queryParams":' + qJson + ',"headers":' + hJson + '}';
        }

        // Safe envelope serialization that operates entirely on primitive strings
        function safeSerializeEnvelope(success, error, env, vars, mutatedReq) {
          const envJson = safeSerializeMap(env);
          const varsJson = safeSerializeMap(vars);

          if (_getUtf8ByteLength(envJson) > 1048576 || _getUtf8ByteLength(varsJson) > 1048576) {
            return '{"success":false,"error":"Output environment or variables exceeded 1 MiB boundary","environment":{},"variables":{}}';
          }

          const mutJson = safeSerializeMutatedReq(mutatedReq);

          if (success) {
            return '{"success":true,"environment":' + envJson + ',"variables":' + varsJson + ',"mutatedRequest":' + mutJson + '}';
          } else {
            let errStr = _String(error || '');
            if (_getUtf8ByteLength(errStr) > 32768) {
              errStr = _truncateUtf8(errStr, 32768);
            }
            return '{"success":false,"error":' + _JSON_stringify(errStr) + ',"environment":' + envJson + ',"variables":' + varsJson + '}';
          }
        }

        function createPmRequest(rawReq) {
          if (!rawReq || typeof rawReq !== 'object') return undefined;

          const rawUrl = typeof rawReq.url === 'string' ? rawReq.url : '';
          const hashIdx = rawUrl.indexOf('#');
          const urlWithoutHash = hashIdx >= 0 ? rawUrl.substring(0, hashIdx) : rawUrl;
          const qIdx = urlWithoutHash.indexOf('?');
          const baseUrl = qIdx >= 0 ? urlWithoutHash.substring(0, qIdx) : urlWithoutHash;

          const queryList = [];

          if (qIdx >= 0) {
            const qStr = urlWithoutHash.substring(qIdx + 1);
            if (_Reflect_apply(_String_prototype_trim, qStr, [])) {
              const pairs = qStr.split('&');
              for (let i = 0; i < pairs.length; i++) {
                const pair = pairs[i];
                if (!pair) continue;
                const eq = pair.indexOf('=');
                const k = eq >= 0 ? pair.substring(0, eq) : pair;
                const v = eq >= 0 ? pair.substring(eq + 1) : '';
                if (k || v) {
                  queryList.push({ key: k, value: v });
                }
              }
            }
          }

          if (_Array_isArray(rawReq.params)) {
            for (let i = 0; i < rawReq.params.length; i++) {
              const p = rawReq.params[i];
              if (p && p.enabled !== false && typeof p.key === 'string') {
                const k = _Reflect_apply(_String_prototype_trim, p.key, []);
                const v = p.value !== undefined ? _String(p.value) : '';
                if (k !== '' || _Reflect_apply(_String_prototype_trim, v, []) !== '') {
                  let exists = false;
                  for (let j = 0; j < queryList.length; j++) {
                    if (queryList[j].key === k) {
                      exists = true;
                      break;
                    }
                  }
                  if (!exists) {
                    queryList.push({ key: k, value: v });
                  }
                }
              }
            }
          }

          const headerList = [];
          if (_Array_isArray(rawReq.headers)) {
            for (let i = 0; i < rawReq.headers.length; i++) {
              const h = rawReq.headers[i];
              if (h && h.enabled !== false && typeof h.key === 'string') {
                const k = _Reflect_apply(_String_prototype_trim, h.key, []);
                if (k !== '') {
                  headerList.push({ key: k, value: h.value !== undefined ? _String(h.value) : '' });
                }
              }
            }
          } else if (rawReq.headers && typeof rawReq.headers === 'object') {
            const hKeys = _Object_keys(rawReq.headers);
            for (let i = 0; i < hKeys.length; i++) {
              const k = hKeys[i];
              if (typeof k === 'string') {
                const trimmedK = _Reflect_apply(_String_prototype_trim, k, []);
                if (trimmedK !== '') {
                  headerList.push({ key: trimmedK, value: _String(rawReq.headers[k] ?? '') });
                }
              }
            }
          }

          const method = typeof rawReq.method === 'string' && rawReq.method
            ? _Reflect_apply(_String_prototype_toUpperCase, rawReq.method, [])
            : 'GET';
          const rawBodyObj = rawReq.body || {};
          const bodyMode = _String(rawBodyObj.mode || 'none');
          const rawBody = _String(rawBodyObj.raw || '');

          const query = {
            get: function(k) {
              for (let i = 0; i < queryList.length; i++) {
                if (queryList[i].key === k) return queryList[i].value;
              }
              return undefined;
            },
            set: function(k, v) {
              if (isForbiddenKey(k)) return;
              for (let i = 0; i < queryList.length; i++) {
                if (queryList[i].key === k) {
                  queryList[i].value = _String(v ?? '');
                  return;
                }
              }
              queryList.push({ key: _String(k), value: _String(v ?? '') });
            },
            upsert: function(param) {
              if (!param || typeof param !== 'object') return;
              const k = _String(param.key || '');
              if (!k || isForbiddenKey(k)) return;
              const v = _String(param.value ?? '');
              for (let i = 0; i < queryList.length; i++) {
                if (queryList[i].key === k) {
                  queryList[i].value = v;
                  return;
                }
              }
              queryList.push({ key: k, value: v });
            },
            add: function(param) {
              if (!param) return;
              if (typeof param === 'string') {
                const eq = param.indexOf('=');
                const k = eq >= 0 ? param.substring(0, eq) : param;
                const v = eq >= 0 ? param.substring(eq + 1) : '';
                if (k && !isForbiddenKey(k)) {
                  queryList.push({ key: k, value: v });
                }
              } else if (typeof param === 'object') {
                const k = _String(param.key || '');
                if (k && !isForbiddenKey(k)) {
                  queryList.push({ key: k, value: _String(param.value ?? '') });
                }
              }
            },
            remove: function(k) {
              for (let i = queryList.length - 1; i >= 0; i--) {
                if (queryList[i].key === k) {
                  queryList.splice(i, 1);
                }
              }
            },
            has: function(k) {
              for (let i = 0; i < queryList.length; i++) {
                if (queryList[i].key === k) return true;
              }
              return false;
            },
            all: function() {
              const res = [];
              for (let i = 0; i < queryList.length; i++) {
                res.push({ key: queryList[i].key, value: queryList[i].value });
              }
              return res;
            },
            count: function() {
              return queryList.length;
            },
            clear: function() {
              queryList.length = 0;
            },
            toString: function() {
              let res = '';
              for (let i = 0; i < queryList.length; i++) {
                if (i > 0) res += '&';
                const item = queryList[i];
                res += item.value !== '' ? item.key + '=' + item.value : item.key;
              }
              return res;
            },
            getQueryString: function() {
              return this.toString();
            }
          };

          const headers = {
            get: function(k) {
              if (!k) return undefined;
              const target = _Reflect_apply(_String_prototype_toLowerCase, _String(k), []);
              for (let i = 0; i < headerList.length; i++) {
                if (_Reflect_apply(_String_prototype_toLowerCase, headerList[i].key, []) === target) {
                  return headerList[i].value;
                }
              }
              return undefined;
            },
            set: function(k, v) {
              if (!k || isForbiddenKey(k)) return;
              const target = _Reflect_apply(_String_prototype_toLowerCase, _String(k), []);
              for (let i = 0; i < headerList.length; i++) {
                if (_Reflect_apply(_String_prototype_toLowerCase, headerList[i].key, []) === target) {
                  headerList[i].value = _String(v ?? '');
                  return;
                }
              }
              headerList.push({ key: _String(k), value: _String(v ?? '') });
            },
            upsert: function(header) {
              if (!header || typeof header !== 'object') return;
              const k = _String(header.key || '');
              if (!k || isForbiddenKey(k)) return;
              const target = _Reflect_apply(_String_prototype_toLowerCase, k, []);
              const v = _String(header.value ?? '');
              for (let i = 0; i < headerList.length; i++) {
                if (_Reflect_apply(_String_prototype_toLowerCase, headerList[i].key, []) === target) {
                  headerList[i].key = k;
                  headerList[i].value = v;
                  return;
                }
              }
              headerList.push({ key: k, value: v });
            },
            add: function(header) {
              if (!header || typeof header !== 'object') return;
              const k = _String(header.key || '');
              if (!k || isForbiddenKey(k)) return;
              headerList.push({ key: k, value: _String(header.value ?? '') });
            },
            remove: function(k) {
              if (!k) return;
              const target = _Reflect_apply(_String_prototype_toLowerCase, _String(k), []);
              for (let i = headerList.length - 1; i >= 0; i--) {
                if (_Reflect_apply(_String_prototype_toLowerCase, headerList[i].key, []) === target) {
                  headerList.splice(i, 1);
                }
              }
            },
            has: function(k) {
              if (!k) return false;
              const target = _Reflect_apply(_String_prototype_toLowerCase, _String(k), []);
              for (let i = 0; i < headerList.length; i++) {
                if (_Reflect_apply(_String_prototype_toLowerCase, headerList[i].key, []) === target) {
                  return true;
                }
              }
              return false;
            },
            all: function() {
              const res = [];
              for (let i = 0; i < headerList.length; i++) {
                res.push({ key: headerList[i].key, value: headerList[i].value });
              }
              return res;
            },
            count: function() {
              return headerList.length;
            },
            clear: function() {
              headerList.length = 0;
            },
            toObject: function() {
              const obj = {};
              for (let i = 0; i < headerList.length; i++) {
                obj[headerList[i].key] = headerList[i].value;
              }
              return obj;
            }
          };

          let protocol = '';
          let host = [];
          let path = [];
          const protoIdx = baseUrl.indexOf('://');
          let afterProto = baseUrl;
          if (protoIdx > 0) {
            protocol = _Reflect_apply(_String_prototype_toLowerCase, baseUrl.substring(0, protoIdx), []);
            afterProto = baseUrl.substring(protoIdx + 3);
          }
          const firstSlash = afterProto.indexOf('/');
          let hostPart = '';
          let pathPart = '';
          if (firstSlash >= 0) {
            hostPart = afterProto.substring(0, firstSlash);
            pathPart = afterProto.substring(firstSlash + 1);
          } else {
            hostPart = afterProto;
          }
          if (hostPart) {
            const rawParts = hostPart.split('.');
            for (let i = 0; i < rawParts.length; i++) {
              if (rawParts[i]) host.push(rawParts[i]);
            }
          }
          if (pathPart) {
            const rawParts = pathPart.split('/');
            for (let i = 0; i < rawParts.length; i++) {
              if (rawParts[i]) path.push(rawParts[i]);
            }
          }

          const url = {
            protocol: protocol,
            host: host,
            path: path,
            query: query,
            toString: function() {
              const qs = query.toString();
              return qs ? baseUrl + '?' + qs : baseUrl;
            },
            getQueryString: function() {
              return query.toString();
            },
            addQueryParams: function(params) {
              if (_Array_isArray(params)) {
                for (let i = 0; i < params.length; i++) {
                  query.add(params[i]);
                }
              } else if (typeof params === 'string') {
                query.add(params);
              }
            },
            removeQueryParams: function(params) {
              if (_Array_isArray(params)) {
                for (let i = 0; i < params.length; i++) {
                  query.remove(params[i]);
                }
              } else if (typeof params === 'string') {
                query.remove(params);
              }
            }
          };

          const body = {
            mode: bodyMode,
            raw: rawBody,
            urlencoded: {
              all: function() { return _Array_isArray(rawBodyObj.urlencoded) ? rawBodyObj.urlencoded : []; }
            },
            formdata: {
              all: function() { return _Array_isArray(rawBodyObj.formdata) ? rawBodyObj.formdata : []; }
            }
          };

          return {
            method: method,
            url: url,
            headers: headers,
            body: body
          };
        }

        globalThis.__runAirrestScript = function(payloadJson) {
          const payload = _JSON_parse(payloadJson);
          const initialEnv = _Object_assign({}, payload.environment || {});
          const initialVars = _Object_assign({}, payload.variables || {});
          const currentEnv = _Object_assign({}, payload.environment || {});
          const currentVars = _Object_assign({}, payload.variables || {});
          const response = payload.response;

          const pm = {
            request: createPmRequest(payload.request),
            environment: {
              get: function(k) { return currentEnv[k]; },
              set: function(k, v) {
                if (isForbiddenKey(k)) return;
                currentEnv[k] = _String(v);
              },
              unset: function(k) { delete currentEnv[k]; },
              has: function(k) { return _Reflect_apply(_Object_prototype_hasOwnProperty, currentEnv, [k]); },
              toObject: function() { return _Object_assign({}, currentEnv); }
            },
            variables: {
              get: function(k) { return currentVars[k] !== undefined ? currentVars[k] : currentEnv[k]; },
              set: function(k, v) {
                if (isForbiddenKey(k)) return;
                currentVars[k] = _String(v);
              },
              toObject: function() { return _Object_assign({}, currentVars); }
            },
            response: response ? {
              code: response.status,
              status: response.statusText,
              headers: response.headers || {},
              json: function() {
                return typeof response.data === 'object' && response.data !== null
                  ? response.data
                  : _JSON_parse(response.data || '{}');
              },
              text: function() {
                return typeof response.data === 'string' ? response.data : _JSON_stringify(response.data || '');
              },
              to: {
                have: {
                  status: function(code) {
                    if (response.status !== code) {
                      throw new Error('Expected status code ' + code + ' but got ' + response.status);
                    }
                  }
                }
              }
            } : undefined,
            test: function(name, fn) {
              try {
                if (typeof fn === 'function') fn();
              } catch (err) {
                throw new Error('Test [' + name + '] failed: ' + (err && err.message ? err.message : _String(err)));
              }
            },
            expect: function(actual) {
              return {
                to: {
                  be: function(expected) {
                    if (actual !== expected) throw new Error('Expected ' + expected + ' but got ' + actual);
                  },
                  equal: function(expected) {
                    if (actual != expected) throw new Error('Expected ' + expected + ' but got ' + actual);
                  }
                }
              };
            }
          };

          const postman = {
            setEnvironmentVariable: function(k, v) {
              if (isForbiddenKey(k)) return;
              currentEnv[k] = _String(v);
            },
            getEnvironmentVariable: function(k) { return currentEnv[k]; },
            clearEnvironmentVariable: function(k) { delete currentEnv[k]; },
            setGlobalVariable: function(k, v) {
              if (isForbiddenKey(k)) return;
              currentVars[k] = _String(v);
            },
            getGlobalVariable: function(k) { return currentVars[k]; },
            clearGlobalVariable: function(k) { delete currentVars[k]; }
          };

          const rawBody = response
            ? (typeof response.data === 'string' ? response.data : _JSON_stringify(response.data || ''))
            : '';
          const responseCode = response ? { code: response.status, name: response.statusText } : { code: 0, name: '' };
          const responseTime = response ? (response.timeMs || 0) : 0;
          const responseHeaders = response ? (response.headers || {}) : {};
          const tests = {};

          globalThis.pm = pm;
          globalThis.postman = postman;
          globalThis.response = rawBody;
          globalThis.responseBody = rawBody;
          globalThis.responseCode = responseCode;
          globalThis.responseTime = responseTime;
          globalThis.responseHeaders = responseHeaders;
          globalThis.tests = tests;

          try {
            const userFn = new Function('pm', 'postman', 'response', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders', 'tests', payload.script);
            userFn(pm, postman, rawBody, rawBody, responseCode, responseTime, responseHeaders, tests);

            const mutatedReq = pm.request ? {
              url: pm.request.url.toString(),
              queryParams: pm.request.url.query.all(),
              headers: pm.request.headers.all(),
            } : null;

            return safeSerializeEnvelope(true, null, currentEnv, currentVars, mutatedReq);
          } catch (err) {
            throw err;
          }
        };
      })();
    `;

    const preambleHandle = context.evalCode(guestPreamble);
    if (preambleHandle.error) {
      const err = context.dump(preambleHandle.error);
      preambleHandle.error.dispose();
      throw new Error(`Failed to initialize guest sandbox: ${JSON.stringify(err)}`);
    }
    if (preambleHandle.value) {
      preambleHandle.value.dispose();
    }

    const errorFormatterCode = `
      (function() {
        const _Reflect_apply = Reflect.apply;
        const _Object_getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
        const _String = String;
        const _String_prototype_charCodeAt = String.prototype.charCodeAt;
        const _String_prototype_slice = String.prototype.slice;
        const _Math_max = Math.max;

        function getBytes(str) {
          if (!str) return 0;
          let bytes = 0;
          const len = str.length;
          for (let i = 0; i < len; i++) {
            const code = _Reflect_apply(_String_prototype_charCodeAt, str, [i]);
            if (code <= 0x7f) bytes += 1;
            else if (code <= 0x7ff) bytes += 2;
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
              const next = _Reflect_apply(_String_prototype_charCodeAt, str, [i + 1]);
              if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
              else bytes += 3;
            } else bytes += 3;
          }
          return bytes;
        }

        function truncate(str, maxBytes) {
          if (getBytes(str) <= maxBytes) return str;
          const suffix = '... (truncated)';
          const targetBytes = _Math_max(0, maxBytes - getBytes(suffix));
          let cur = 0;
          let cut = 0;
          for (let i = 0; i < str.length; i++) {
            const code = _Reflect_apply(_String_prototype_charCodeAt, str, [i]);
            let b = 1;
            let pair = false;
            if (code > 0x7f) {
              if (code <= 0x7ff) b = 2;
              else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
                const n = _Reflect_apply(_String_prototype_charCodeAt, str, [i + 1]);
                if (n >= 0xdc00 && n <= 0xdfff) { b = 4; pair = true; }
                else b = 3;
              } else b = 3;
            }
            if (cur + b > targetBytes) break;
            cur += b;
            cut = pair ? i + 2 : i + 1;
            if (pair) i++;
          }
          return _Reflect_apply(_String_prototype_slice, str, [0, cut]) + suffix;
        }

        return function(err) {
          try {
            let str = 'Script execution failed.';
            if (typeof err === 'string') {
              str = err;
            } else if (err && typeof err === 'object') {
              try {
                const desc = _Reflect_apply(_Object_getOwnPropertyDescriptor, Object, [err, 'message']);
                if (desc && typeof desc.value === 'string') {
                  str = desc.value;
                }
              } catch {}
              if (str === 'Script execution failed.') {
                try {
                  if (typeof err.message === 'string') str = err.message;
                } catch {
                  str = 'Script execution threw an error with an unreadable message.';
                }
              }
              if (str === 'Script execution failed.') {
                try {
                  str = _String(err);
                } catch {
                  str = 'Script execution threw an uncoercible error.';
                }
              }
            } else {
              try {
                str = _String(err);
              } catch {
                str = 'Script execution threw an uncoercible value.';
              }
            }
            return truncate(str, 32768);
          } catch {
            return 'Script execution failed.';
          }
        };
      })()
    `;
    const formatRes = context.evalCode(errorFormatterCode);
    if (formatRes.error) {
      const err = context.dump(formatRes.error);
      formatRes.error.dispose();
      throw new Error(`Failed to initialize guest error boundary: ${JSON.stringify(err)}`);
    }
    errorFormatterFn = formatRes.value;

    if (/\bCryptoJS\b/.test(input.script)) {
      const cryptoHandle = context.evalCode(CRYPTO_JS_SOURCE + '\n;globalThis.CryptoJS = CryptoJS;');
      if (cryptoHandle.error) {
        cryptoHandle.error.dispose();
      } else {
        cryptoHandle.value.dispose();
      }
    }

    const payloadString = JSON.stringify({
      script: input.script,
      environment: input.environment || {},
      variables: input.variables || {},
      request: input.request,
      response: input.response,
    });

    const payloadHandle = context.newString(payloadString);
    context.setProp(context.global, '__airrestPayload', payloadHandle);
    payloadHandle.dispose();

    deadline = Date.now() + timeoutMs;
    timedOut = false;
    if (options?.onEvalStart) {
      options.onEvalStart();
    }
    const evalHandle = context.evalCode('globalThis.__runAirrestScript(globalThis.__airrestPayload)');
    context.setProp(context.global, '__airrestPayload', context.undefined);

    if (evalHandle.error) {
      if (options?.signal?.aborted || abortedBySignal) {
        evalHandle.error.dispose();
        return {
          success: false,
          error: 'Script execution aborted.',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        };
      }

      let errNameOrMessage = '';
      try {
        errNameOrMessage = context.getString(evalHandle.error);
      } catch {
        // ignore
      }

      if (/out of memory/i.test(errNameOrMessage)) {
        evalHandle.error.dispose();
        return validateScriptOutput({
          success: false,
          error: 'out of memory',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        }, input);
      }

      if (timedOut) {
        evalHandle.error.dispose();
        return {
          success: false,
          error: 'Script execution timed out.',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        };
      }

      let message = 'Script execution failed.';
      try {
        if (errorFormatterFn) {
          // Maintain active interrupt handler with a strict bounded cleanup deadline (max 50ms)
          const cleanupDeadline = Date.now() + 50;
          let cleanupInterrupted = false;
          runtime.setInterruptHandler(() => {
            if (options?.signal?.aborted) {
              abortedBySignal = true;
              return true;
            }
            if (Date.now() > cleanupDeadline) {
              cleanupInterrupted = true;
              return true;
            }
            return false;
          });

          const boundedRes = context.callFunction(errorFormatterFn, context.undefined, evalHandle.error);
          if ('value' in boundedRes && boundedRes.value) {
            message = context.getString(boundedRes.value);
            boundedRes.value.dispose();
          } else if ('error' in boundedRes && boundedRes.error) {
            let errStr = '';
            try {
              errStr = context.getString(boundedRes.error);
            } catch {
              // ignore
            }
            boundedRes.error.dispose();
            if (cleanupInterrupted || errStr.includes('interrupted') || Date.now() >= cleanupDeadline) {
              cleanupInterrupted = true;
              message = 'Script execution timed out.';
            } else {
              message = 'Script execution failed.';
            }
          }
        }
      } catch {
        message = 'Script execution failed.';
      } finally {
        evalHandle.error.dispose();
      }

      if (options?.signal?.aborted || abortedBySignal) {
        return {
          success: false,
          error: 'Script execution aborted.',
          environment: { ...(input.environment || {}) },
          variables: { ...(input.variables || {}) },
        };
      }

      const isTimeout = message.includes('interrupted') || message === 'Script execution timed out.' || Date.now() > deadline;
      const finalError = isTimeout
        ? 'Script execution timed out.'
        : describeInternalParameterRedefinition(message, input.script);

      return validateScriptOutput({
        success: false,
        error: finalError,
        environment: { ...(input.environment || {}) },
        variables: { ...(input.variables || {}) },
      }, input);
    }

    const rawResultJson = context.dump(evalHandle.value);
    evalHandle.value.dispose();

    if (typeof rawResultJson !== 'string') {
      return {
        success: false,
        error: 'Invalid non-string result returned from guest.',
        environment: { ...(input.environment || {}) },
        variables: { ...(input.variables || {}) },
      };
    }

    if (getUtf8ByteLength(rawResultJson) > 2 * 1024 * 1024) {
      return {
        success: false,
        error: 'Script output exceeded maximum transfer limit (2 MiB).',
        environment: { ...(input.environment || {}) },
        variables: { ...(input.variables || {}) },
      };
    }

    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(rawResultJson);
    } catch {
      return {
        success: false,
        error: 'Failed to parse guest script result.',
        environment: { ...(input.environment || {}) },
        variables: { ...(input.variables || {}) },
      };
    }

    // 2. Strict host boundary output validation
    return validateScriptOutput(parsedResult, input);
  } finally {
    if (errorFormatterFn) {
      errorFormatterFn.dispose();
    }
    context.dispose();
    runtime.dispose();
  }
}
