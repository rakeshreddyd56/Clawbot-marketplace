import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const { app } = await createApp();

try {
  const address = await app.listen({ port, host });
  console.log(`api listening on ${address}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
