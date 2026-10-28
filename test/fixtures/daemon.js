import { SuwinServer } from '../../src/server.js';

const server = new SuwinServer({ tray: false });
await server.start();
server.activate(60000);
process.send?.({ ready: true });
process.on('message', async message => {
  if (message === 'stop') { await server.stop(); process.disconnect(); }
});
