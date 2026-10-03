

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET(req, res) {
  // res.json takes one argument, so the second was dropped and these headers never
  // reached the client. The health endpoint is public and read cross-origin.
  return res.set(CORS_HEADERS).json({ ok: true });
}

export async function OPTIONS() {
  // NextResponse is a Next.js import this Express router never had; every
    // preflight to /api/health threw ReferenceError.
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
