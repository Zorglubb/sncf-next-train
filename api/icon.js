// api/icon.js

export const config = {
  runtime: 'edge',
};

export default function handler(req) {
  // SVG avec arrière-plan opaque et safe zone pour Android
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" rx="100" fill="#1e293b"/>
    <path d="M144 110h224c35 0 64 29 64 64v170c0 35-29 64-64 64l32 32v16H112v-16l32-32c-35 0-64-29-64-64V174c0-35 29-64 64-64zm32 60c-8 0-16 8-16 16v64c0 8 8 16 16 16h160c8 0 16-8 16-16v-64c0-8-8-16-16-16H176zm16 180a24 24 0 1 0 0-48 24 24 0 0 0 0 48zm128 0a24 24 0 1 0 0-48 24 24 0 0 0 0 48z" fill="#38bdf8"/>
  </svg>`;

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
