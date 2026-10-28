import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ type: 'ready', hwnd: null });
parentPort.on('message', message => {
  if (message.type === 'status') {
    parentPort.postMessage({ type: 'blocked' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    parentPort.postMessage({ type: 'unblocked' });
  } else if (message.type === 'stop') parentPort.close();
});
