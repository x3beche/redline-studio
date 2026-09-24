// The API the dev server hands /api to. Read from the environment rather
// than written down, so a second checkout can run its own pair of servers
// (API_PORT=8001 WEB_PORT=4201 ./start.sh) without its page quietly
// talking to the first checkout's API.
export default {
  '/api': {
    target: `http://127.0.0.1:${process.env.API_PORT || 8000}`,
    secure: false,
  },
};
