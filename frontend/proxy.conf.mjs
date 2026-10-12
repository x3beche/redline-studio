// The API the dev server hands /api to. Read from the environment rather
// than written down, so a second checkout can run its own pair of servers
// (API_PORT=8001 WEB_PORT=4201 ./start.sh) without its page quietly
// talking to the first checkout's API.
export default {
  '/api': {
    target: `http://127.0.0.1:${process.env.API_PORT || 8000}`,
    secure: false,
    // An answer cut short by the API (a reload: uvicorn --reload, on every
    // backend save) is cut short for the page too. The dev server's proxy
    // (vite's) otherwise kept the page's side open and silent for ever: a
    // Chat answer or a live stream stalled until the page was loaded again.
    configure: (proxy) => {
      proxy.on('proxyRes', (upstream, req, res) => {
        upstream.on('close', () => {
          if (!upstream.complete && !res.writableEnded) res.destroy();
        });
      });
    },
  },
};
