import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const normalizePath = (path) => path
  .replace(/\{\{[^}]+\}\}|\{[^}]+\}/g, '{}')
  .replace(/\/$/, '') || '/';

function collectRequests(items, output = []) {
  for (const item of items) {
    if (item.item) collectRequests(item.item, output);
    if (item.request) output.push(item);
  }
  return output;
}

test('Postman collection contains every documented OpenAPI operation exactly as a method/path pair', () => {
  const openapi = JSON.parse(fs.readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
  const collection = JSON.parse(fs.readFileSync(new URL('../backend/airrest_api_collection.json', import.meta.url), 'utf8'));
  const operations = new Set(
    Object.entries(openapi.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((method) => /^(get|post|put|patch|delete|options|head)$/.test(method))
        .map((method) => `${method.toUpperCase()} ${normalizePath(path)}`),
    ),
  );
  const requests = collectRequests(collection.item);
  const collectionOperations = new Set(
    requests.map(({ request }) => `${request.method} ${normalizePath(`/${request.url.path.join('/')}`)}`),
  );

  assert.deepEqual([...collectionOperations].filter((operation) => !operations.has(operation)), []);
  assert.deepEqual([...operations].filter((operation) => !collectionOperations.has(operation)), []);
});

test('environment OCC contract and registration test assertion remain synchronized', () => {
  const contract = fs.readFileSync(new URL('../backend/API_CONTRACT.md', import.meta.url), 'utf8');
  const openapi = fs.readFileSync(new URL('../backend/openapi.yaml', import.meta.url), 'utf8');
  const collection = JSON.parse(fs.readFileSync(new URL('../backend/airrest_api_collection.json', import.meta.url), 'utf8'));
  const registration = collectRequests(collection.item).find(({ name }) => name === 'Register New User');
  const testScript = registration.event.find(({ listen }) => listen === 'test').script.exec.join('\n');

  assert.match(contract, /"base_version": int64/);
  assert.match(openapi, /UpdateEnvironmentRequest:[\s\S]*?required:[\s\S]*?- base_version/);
  assert.match(testScript, /res\.success/);
  assert.match(testScript, /REGISTRATION_DISABLED/);
  assert.match(testScript, /res\.error/);
});
