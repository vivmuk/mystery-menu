import { createGameServer } from './server.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const { http } = createGameServer();

http.listen(port, host, () => {
  console.log(`mystery-menu listening on http://${host}:${port}`);
});
