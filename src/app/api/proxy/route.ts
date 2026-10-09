import { NextRequest, NextResponse } from 'next/server';


interface ProxyRequestBody {
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function POST(req: NextRequest) {
  const startTime = performance.now();

  try {
    const payload = (await req.json()) as ProxyRequestBody;
    const { targetUrl, method = 'GET', headers = {}, body } = payload;

    if (!targetUrl || typeof targetUrl !== 'string') {
      return NextResponse.json(
        {
          status: 400,
          statusText: 'Bad Request',
          timeMs: 0,
          sizeBytes: 0,
          headers: {},
          data: 'Target URL is required and must be a valid URL string.',
          isError: true,
          errorDetail: 'Missing targetUrl parameter',
          timestamp: Date.now(),
        },
        { status: 400 }
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return NextResponse.json(
        {
          status: 400,
          statusText: 'Invalid URL',
          timeMs: 0,
          sizeBytes: 0,
          headers: {},
          data: `Invalid URL format: "${targetUrl}". Ensure it starts with http:// or https://`,
          isError: true,
          errorDetail: 'Invalid URL',
          timestamp: Date.now(),
        },
        { status: 400 }
      );
    }

    // Filter out hop-by-hop headers and host header that can cause fetch issues
    const filteredHeaders: Record<string, string> = {};
    const restrictedHeaders = new Set([
      'host',
      'connection',
      'keep-alive',
      'transfer-encoding',
      'te',
      'upgrade',
      'content-length',
    ]);

    for (const [key, value] of Object.entries(headers)) {
      if (!restrictedHeaders.has(key.toLowerCase()) && value !== undefined && value !== '') {
        filteredHeaders[key] = value;
      }
    }

    // Set User-Agent if not provided
    if (!filteredHeaders['User-Agent'] && !filteredHeaders['user-agent']) {
      filteredHeaders['User-Agent'] = 'ApiTester/1.0';
    }

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: filteredHeaders,
      redirect: 'follow',
      cache: 'no-store',
    };

    // Only attach body for non-GET / non-HEAD requests
    const upperMethod = method.toUpperCase();
    if (upperMethod !== 'GET' && upperMethod !== 'HEAD' && body !== undefined && body !== null && body !== '') {
      fetchOptions.body = body;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 25000); // 25s timeout
    fetchOptions.signal = abortController.signal;

    let response: Response;
    try {
      response = await fetch(parsedUrl.toString(), fetchOptions);
    } finally {
      clearTimeout(timeout);
    }

    const duration = Math.round(performance.now() - startTime);

    // Extract headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    // Read response body as text
    const textData = await response.text();
    const sizeBytes = new Blob([textData]).size;

    return NextResponse.json({
      status: response.status,
      statusText: response.statusText || (response.ok ? 'OK' : 'Error'),
      timeMs: duration,
      sizeBytes,
      headers: responseHeaders,
      data: textData,
      isError: !response.ok,
      timestamp: Date.now(),
    });
  } catch (err: unknown) {
    const duration = Math.round(performance.now() - startTime);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMessage.includes('aborted') || errorMessage.includes('timeout');

    return NextResponse.json(
      {
        status: isTimeout ? 504 : 502,
        statusText: isTimeout ? 'Gateway Timeout' : 'Bad Gateway',
        timeMs: duration,
        sizeBytes: 0,
        headers: {},
        data: `Proxy request failed: ${errorMessage}`,
        isError: true,
        errorDetail: errorMessage,
        timestamp: Date.now(),
      },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
