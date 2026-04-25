import type { APIGatewayProxyHandler, APIGatewayProxyEvent } from 'aws-lambda';

export const handler: APIGatewayProxyHandler = async (event) => {
  const claims = readClaims(event);
  console.log(JSON.stringify({ level: 'info', msg: 'ping', sub: claims.sub, email: claims.email }));
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      env: process.env.ENV_NAME,
      at: new Date().toISOString(),
      user: { sub: claims.sub, email: claims.email },
    }),
  };
};

function readClaims(event: APIGatewayProxyEvent): { sub?: string; email?: string } {
  const anyEvent = event as unknown as {
    requestContext?: { authorizer?: { claims?: Record<string, string>; jwt?: { claims?: Record<string, string> } } };
  };
  const rest = anyEvent.requestContext?.authorizer?.claims;
  const http = anyEvent.requestContext?.authorizer?.jwt?.claims;
  const c = rest ?? http ?? {};
  return { sub: c.sub, email: c.email };
}
