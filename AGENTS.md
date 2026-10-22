
## Personal Project & Privacy Sanitization

This repository is a **personal project**, not a corporate/company project.

1. **Zero Corporate Mentions**: Never introduce, suggest, or keep employer names, company names, internal corporate domains (e.g., private corporate intranets, `*.corp.*`, internal VPN hosts), or company-internal infrastructure names in any code, comments, sample datasets, export metadata, or documentation (`README.md`).
2. **Generic Sample Data**: Always use neutral, standard conventions for demo/sample URLs, headers, and query parameters (e.g., `https://httpbin.org/get?user=tester&tag=api`, `localhost`, RFC 2606 `example.com`, or `jsonplaceholder.typicode.com`).
3. **Neutral Branding**: In export headers, application titles, and Postman export metadata (e.g., `_postman_exported_using`), strictly use neutral project names (e.g., `AirREST`), avoiding any employer or company prefixes.

## API Contract Maintenance & Synchronization

Whenever there are modifications, additions, or deprecations to backend REST endpoints, request/response payload schemas, query parameters, authentication mechanisms, error envelopes, or role-based access controls (RBAC):

1. **Mandatory Contract Synchronization**: You MUST update all existing API contract documents to keep them in 100% sync with the backend implementation and frontend expectations:
   - `backend/openapi.yaml`: Update the OpenAPI 3.1.0 YAML specification with new/modified routes, parameters, schemas, and response envelopes.
   - `backend/openapi.json`: Re-generate or synchronize the JSON equivalent of the OpenAPI specification.
   - `backend/API_CONTRACT.md`: Update the re-implementation guide, architectural protocols, OCC rules, and frontend expected value tables.
   - `backend/airrest_api_collection.json`: Update the Postman / AirREST test collection if endpoint paths, headers, or request bodies change.
2. **Type & Value Parity**: Ensure that field names, data types (e.g., boolean vs string), and strict enum values (e.g., roles, item types, methods) match across the OpenAPI specs, markdown guide, backend code, and frontend client handlers.
3. **Syntax Validation**: Always validate the YAML/JSON syntax of `backend/openapi.yaml` and `backend/openapi.json` after making updates to ensure machine-readability.

