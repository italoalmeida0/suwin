import { parentPort, workerData } from 'node:worker_threads';
import { NativeTrayIcon } from './tray-native.js';

let status = workerData.status;
const controller = {
  stateDir: workerData.dir,
  get port() { return status.port; },
  getStatus: () => status,
  isActive: () => status.active,
  activate: duration => parentPort.postMessage({ type: 'activate', duration }),
  deactivate: () => parentPort.postMessage({ type: 'deactivate' }),
  quit: () => parentPort.postMessage({ type: 'quit' }),
  logger: { warn: message => parentPort.postMessage({ type: 'warning', message }) }
};
const tray = new NativeTrayIcon(controller);
try {
  tray.start();
  parentPort.postMessage({ type: 'ready', hwnd: tray.hwnd });
  parentPort.on('message', message => {
    if (message.type === 'status') { status = message.status; tray.update(); }
    else if (message.type === 'stop') { tray.destroy(); parentPort.close(); }
  });
} catch (error) {
  parentPort.postMessage({ type: 'failed', message: error.message });
  parentPort.close();
}
