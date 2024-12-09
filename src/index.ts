interface ErrorResponse {
    detail: string
}


function jsonError(message: string, status: number): Response {
    return new Response(
        JSON.stringify({ detail: message } as ErrorResponse),
        {
            status,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            }
        }
    )
}


export default {
    async fetch(request: Request, env: Env, ctx:ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
    
        if (
            request.method === 'POST' &&
            url.pathname === '/discord/event'
        ) {
            if (request.headers.get('Authorization') !== env.MASTER_TOKEN) {
                return jsonError('Unauthorized', 401);
            }
            
            try {
                request = await handleDiscordEvent(request, env);
            }
            catch (error) {
                if (error instanceof Error && error.message === 'DUPLICATE_EVENT') {
                    return new Response('DUPLICATE_EVENT', { status: 200 });
                }

                return jsonError('Internal Server Error', 500);
            }

        }
    
        try {
            return await tryPrimaries(request, env);
        } catch (error) {
            try {
                return tryOrigin(env.FALLBACK_ORIGIN, request);
            } catch (error) {
                return jsonError('Internal Server Error', 500);
            }
        }
    }
}
  
async function handleDiscordEvent(request: Request, env: Env): Promise<Request> {
    const clonedRequest = request.clone();
    const body = await clonedRequest.text();

    const bodyHash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(body)
    );

    const key = Array.from(new Uint8Array(bodyHash)
    ).map(b => b.toString(16).padStart(2, '0')
    ).join('');

    const existingEvent = await env.DISCORD_EVENTS.get(key);

    if (existingEvent) {
        throw new Error('DUPLICATE_EVENT');
    }

    await env.DISCORD_EVENTS.put(key, '1', { expirationTtl: 300 });
    return clonedRequest;
}
  
async function tryPrimaries(request: Request, env: Env): Promise<Response> {
    const availableOrigins = [...env.PRIMARY_ORIGINS];
  
    while (availableOrigins.length > 0) {
        const origin = selectOrigin(availableOrigins);
        try {
            return await tryOrigin(origin.url, request);
        } catch (error) {
            const failedIndex = availableOrigins.findIndex(o => o.url === origin.url);
            if (failedIndex > -1) {
                availableOrigins.splice(failedIndex, 1);
            }
        }
    }
  
    throw new Error('All origins failed');
}
  
async function tryOrigin(origin: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const newUrl = new URL(url.pathname + url.search, origin);
  
    const modifiedRequest = new Request(newUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'follow'
    });

    const response = await fetch(modifiedRequest);
  
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
  
    return response;
  }
  
function selectOrigin(origins: { url: string, weight: number }[]): { url: string, weight: number } {
    if (origins.length === 1) {
        return origins[0];
    }

    const totalWeight = origins.reduce((sum, origin) => sum + origin.weight, 0);
    const random = Math.random() * totalWeight;
  
    let weightSum = 0;
    for (const origin of origins) {
        weightSum += origin.weight;
        if (random <= weightSum) {
            return origin;
        }
    }
  
    return origins[0];
}
  