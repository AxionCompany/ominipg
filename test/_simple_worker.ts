// Minimal module worker used for overhead measurement.
// Posts a 'ready' message on start and exits on 'close'.

self.postMessage({ type: 'ready' });

self.addEventListener('message', (e: MessageEvent) => {
    if (e.data === 'close') {
        self.postMessage({ type: 'closed' });
        self.close();
    }
});


