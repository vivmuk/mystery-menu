import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = createApp();
const http = createServer(app);
const io = new SocketServer(http, {
  serveClient: true,
  cors: { origin: true },
});

// The room protocol lands with the join-flow backlog item. A socket that does
// nothing yet still proves the transport is wired end to end.
io.on('connection', (socket) => {
  socket.emit('hello', { service: 'mystery-menu', socketId: socket.id });
});

http.listen(port, host, () => {
  console.log(`mystery-menu listening on http://${host}:${port}`);
});
