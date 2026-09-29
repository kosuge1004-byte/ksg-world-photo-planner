const NATIVE_APP_ORIGINS = new Set([
  "https://localhost",
  "capacitor://localhost",
]);

function applyNativeCors(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !NATIVE_APP_ORIGINS.has(origin)) return response;
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  response.headers.set("Vary", "Origin");
  return response;
}

export const onRequest: PagesFunction = async (context) => {
  if (context.request.method === "OPTIONS") {
    return applyNativeCors(context.request, new Response(null, { status: 204 }));
  }
  return applyNativeCors(context.request, await context.next());
};
