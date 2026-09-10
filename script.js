const CHUNK_SIZE = 64 * 1024; // 64KB safe chunking window
let peer = null;
let activeConnection = null;

// Batch queue state
let sendQueue = [];
let isProcessingQueue = false;
let incomingTransfers = new Map();

// Memory cleanup tracker
const activeObjectUrls = new Set();

// Metrics tracking
let metricsTimer = null;
let currentTransferStats = {
    startTime: 0,
    transferredBytes: 0,
    totalBytes: 0
};

// Web Audio API Procedural Synth
let audioCtx = null;
function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

function playHapticTone(type) {
    try {
        const ctx = getAudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        if (type === 'connect') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime); // A4
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5
            gain.gain.setValueAtTime(0.04, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.12);
        } else if (type === 'complete') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
            osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.08); // E5
            gain.gain.setValueAtTime(0.05, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.18);
        }
    } catch {
        // Suppress audio policy violations prior to interaction
    }
}

// Dynamic Favicon Generator
function setDynamicFavicon(colorHex) {
    const favicon = document.getElementById('dynamic-favicon');
    if (!favicon) return;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='40' fill='${encodeURIComponent(colorHex)}'/></svg>`;
    favicon.href = `data:image/svg+xml,${svg}`;
}

const elements = {
    myId: document.getElementById('my-id'),
    copyBtn: document.getElementById('copy-btn'),
    shareLinkBtn: document.getElementById('share-link-btn'),
    qrBtn: document.getElementById('qr-btn'),
    logToggleBtn: document.getElementById('log-toggle-btn'),
    statusPill: document.getElementById('status-pill'),
    targetId: document.getElementById('target-id'),
    connectBtn: document.getElementById('connect-btn'),
    feedContainer: document.getElementById('drop-zone'),
    feed: document.getElementById('feed'),
    messageInput: document.getElementById('message-input'),
    fileInput: document.getElementById('file-input'),
    sendBtn: document.getElementById('send-btn'),
    transferTray: document.getElementById('transfer-tray'),
    transferFilename: document.getElementById('transfer-filename'),
    transferMetrics: document.getElementById('transfer-metrics'),
    progressBar: document.getElementById('progress-bar'),
    qrModal: document.getElementById('qr-modal'),
    qrContainer: document.getElementById('qrcode'),
    logDrawer: document.getElementById('log-drawer'),
    debugLog: document.getElementById('debug-log')
};

// Peer Initialization
function generateShortPeerId() {
    return 'p2p-' + Math.random().toString(36).substring(2, 7);
}

function initPeer() {
    const customId = generateShortPeerId();
    
    peer = new Peer(customId, {
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        }
    });

    peer.on('open', (id) => {
        elements.myId.textContent = id;
        elements.copyBtn.disabled = false;
        elements.shareLinkBtn.disabled = false;
        elements.qrBtn.disabled = false;
        setStatus('Ready', 'pill-idle', '#807d72');
        logDiagnostic(`Local peer initialized as ${id}`);

        // Handle auto-connect param ?peer=p2p-xxxxx
        const urlParams = new URLSearchParams(window.location.search);
        const autoConnectId = urlParams.get('peer');
        
        if (autoConnectId) {
            if (/^p2p-[a-z0-9]{5}$/.test(autoConnectId)) {
                if (autoConnectId !== id) {
                    elements.targetId.value = autoConnectId;
                    initiateConnection();
                }
            } else {
                appendSystemNotice('Invalid Peer ID format in query link.');
                logDiagnostic(`Rejected malformed auto-connect param: ${autoConnectId}`);
            }
        }
    });

    peer.on('connection', (conn) => {
        if (activeConnection && activeConnection.open) {
            conn.close();
            logDiagnostic(`Rejected incoming session from ${conn.peer} (busy)`);
            return;
        }
        activeConnection = conn;
        elements.targetId.value = conn.peer;
        bindConnectionEvents();
        logDiagnostic(`Incoming handshake from ${conn.peer}`);
    });

    peer.on('error', (err) => {
        logDiagnostic(`Peer error: ${err.type}`);

        switch (err.type) {
            case 'unavailable-id':
                peer.destroy();
                initPeer();
                break;
            case 'peer-unavailable':
                appendSystemNotice('Target peer not found or offline.');
                resetConnectionUI();
                break;
            case 'network':
                appendSystemNotice('Lost connection to WebRTC signaling servers.');
                setStatus('Offline', 'pill-thinking', '#dfa88f');
                resetConnectionUI();
                break;
            default:
                appendSystemNotice(`Signaling error: ${err.message}`);
                resetConnectionUI();
                break;
        }
    });
}

function initiateConnection() {
    const target = elements.targetId.value.trim();
    if (!target) return;

    if (!/^p2p-[a-z0-9]{5}$/.test(target)) {
        appendSystemNotice('Peer ID must match format p2p-xxxxx');
        return;
    }

    setStatus('Connecting', 'pill-thinking', '#dfa88f');
    elements.connectBtn.disabled = true;
    elements.targetId.disabled = true;
    logDiagnostic(`Establishing DataChannel to ${target}...`);

    activeConnection = peer.connect(target, { reliable: true });
    bindConnectionEvents();
}

function bindConnectionEvents() {
    activeConnection.on('open', () => {
        setStatus('Connected', 'pill-done', '#1f8a65');
        toggleInputs(true);
        appendSystemNotice(`P2P DataChannel open with ${activeConnection.peer}`);
        logDiagnostic(`WebRTC connected to ${activeConnection.peer}`);
        playHapticTone('connect');

        // Request notification permission on first connection
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    });

    activeConnection.on('data', handleIncomingData);

    activeConnection.on('close', () => {
        setStatus('Disconnected', 'pill-idle', '#807d72');
        appendSystemNotice('Peer connection terminated.');
        logDiagnostic('DataChannel closed by remote.');
        resetConnectionUI();
    });

    activeConnection.on('error', (err) => {
        appendSystemNotice(`Channel error: ${err.message}`);
        logDiagnostic(`Channel exception: ${err.message}`);
        resetConnectionUI();
    });
}

function resetConnectionUI() {
    toggleInputs(false);
    elements.connectBtn.disabled = false;
    elements.targetId.disabled = false;
    activeConnection = null;
    sendQueue = [];
    isProcessingQueue = false;
    stopMetricsTracker();
    hideTransferProgress();
}

// Inbound Handling & Demuxer
function handleIncomingData(data) {
    if (data.type === 'chat') {
        appendMessage(data.text, 'in');
        if (document.hidden) {
            triggerBackgroundNotification('New Message', data.text);
            document.title = '(1) New Message · p2p.share';
        }
    } else if (data.type === 'file-meta') {
        incomingTransfers.set(data.id, {
            name: data.name,
            mime: data.mime,
            size: data.size,
            totalChunks: data.totalChunks,
            receivedChunks: []
        });

        startMetricsTracker(data.size);
        showTransferProgress(`Receiving: ${data.name}`, 0);
        logDiagnostic(`Inbound stream initiated: ${data.name} (${formatBytes(data.size)})`);
    } else if (data.type === 'file-chunk') {
        const transfer = incomingTransfers.get(data.id);
        if (!transfer) return;

        transfer.receivedChunks[data.chunkIndex] = data.chunk;
        currentTransferStats.transferredBytes += data.chunk.byteLength;

        const percent = Math.round((transfer.receivedChunks.length / transfer.totalChunks) * 100);
        updateProgressDisplay(percent);

        if (document.hidden) {
            document.title = `(${percent}%) Receiving: ${transfer.name}`;
        }

        if (transfer.receivedChunks.length === transfer.totalChunks) {
            const blob = new Blob(transfer.receivedChunks, { type: transfer.mime });
            appendFilePreview(transfer.name, blob, transfer.mime, 'in');
            stopMetricsTracker();
            hideTransferProgress();
            playHapticTone('complete');

            if (document.hidden) {
                triggerBackgroundNotification('File Received', `${transfer.name} is ready for download.`);
                document.title = '(1) File Ready · p2p.share';
            }

            logDiagnostic(`Inbound stream complete: ${transfer.name}`);
            incomingTransfers.delete(data.id);
        }
    }
}

// Text Messaging
function sendTextMessage() {
    if (!activeConnection || !activeConnection.open) return;
    const text = elements.messageInput.value.trim();
    if (!text) return;

    activeConnection.send({ type: 'chat', text });
    appendMessage(text, 'out');
    elements.messageInput.value = '';
}

elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendTextMessage();
});

// OS Clipboard Image Interception (Ctrl+V)
window.addEventListener('paste', (e) => {
    if (!activeConnection || !activeConnection.open) return;
    
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    const filesToQueue = [];

    for (let item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) filesToQueue.push(file);
        }
    }

    if (filesToQueue.length > 0) {
        e.preventDefault();
        logDiagnostic(`Pasted ${filesToQueue.length} file(s) from clipboard`);
        enqueueFiles(filesToQueue);
    }
});

function handleFileSelect(e) {
    if (e.target.files.length > 0) {
        enqueueFiles(e.target.files);
        e.target.value = '';
    }
}

// Drag & Drop
['dragenter', 'dragover'].forEach(name => {
    elements.feedContainer.addEventListener(name, (e) => {
        e.preventDefault();
        elements.feedContainer.classList.add('drag-over');
    });
});

['dragleave', 'drop'].forEach(name => {
    elements.feedContainer.addEventListener(name, (e) => {
        e.preventDefault();
        elements.feedContainer.classList.remove('drag-over');
    });
});

elements.feedContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.feedContainer.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0 && activeConnection && activeConnection.open) {
        logDiagnostic(`Dropped ${e.dataTransfer.files.length} file(s) onto canvas`);
        enqueueFiles(e.dataTransfer.files);
    }
});

// Batch Queue Manager
function enqueueFiles(fileList) {
    for (let file of fileList) {
        sendQueue.push(file);
    }
    processSendQueue();
}

async function processSendQueue() {
    if (isProcessingQueue || sendQueue.length === 0 || !activeConnection || !activeConnection.open) {
        return;
    }

    isProcessingQueue = true;
    const totalInBatch = sendQueue.length;
    let completed = 0;

    while (sendQueue.length > 0) {
        const file = sendQueue.shift();
        completed++;
        const statusPrefix = totalInBatch > 1 ? `(${completed}/${totalInBatch}) ` : '';
        await sendSingleFileChunked(file, statusPrefix);
    }

    isProcessingQueue = false;
}

function sendSingleFileChunked(file, statusPrefix) {
    return new Promise(async (resolve) => {
        const fileId = Math.random().toString(36).substring(2, 9);
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const mime = file.type || 'application/octet-stream';

        logDiagnostic(`Outbound dispatch started: ${file.name} (${formatBytes(file.size)})`);
        startMetricsTracker(file.size);
        showTransferProgress(`${statusPrefix}${file.name}`, 0);

        // 1. Send Manifest
        activeConnection.send({
            type: 'file-meta',
            id: fileId,
            name: file.name,
            mime: mime,
            size: file.size,
            totalChunks: totalChunks
        });

        // 2. Stream byte segments
        for (let i = 0; i < totalChunks; i++) {
            if (!activeConnection || !activeConnection.open) {
                logDiagnostic('Stream aborted: DataChannel disconnected unexpectedly.');
                break;
            }

            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const slice = file.slice(start, end);
            const buffer = await slice.arrayBuffer();

            activeConnection.send({
                type: 'file-chunk',
                id: fileId,
                chunkIndex: i,
                chunk: buffer
            });

            currentTransferStats.transferredBytes += buffer.byteLength;
            const percent = Math.round(((i + 1) / totalChunks) * 100);
            updateProgressDisplay(percent);

            if (document.hidden) {
                document.title = `(${percent}%) Sending: ${file.name}`;
            }

            // Yield to avoid saturating WebRTC transmission buffer
            await new Promise((r) => setTimeout(r, 4));
        }

        appendFilePreview(file.name, file, mime, 'out');
        stopMetricsTracker();
        hideTransferProgress();
        playHapticTone('complete');

        if (document.hidden) {
            triggerBackgroundNotification('Transfer Complete', `${file.name} successfully delivered.`);
            document.title = 'Delivered · p2p.share';
        }

        logDiagnostic(`Outbound dispatch finished: ${file.name}`);
        resolve();
    });
}

// Metrics Engine (Speed & ETA)
function startMetricsTracker(totalBytes) {
    currentTransferStats.startTime = performance.now();
    currentTransferStats.transferredBytes = 0;
    currentTransferStats.totalBytes = totalBytes;

    if (metricsTimer) clearInterval(metricsTimer);
    
    metricsTimer = setInterval(() => {
        const elapsedSec = (performance.now() - currentTransferStats.startTime) / 1000;
        if (elapsedSec <= 0) return;

        const speedBytesPerSec = currentTransferStats.transferredBytes / elapsedSec;
        const remainingBytes = Math.max(0, currentTransferStats.totalBytes - currentTransferStats.transferredBytes);
        const etaSeconds = speedBytesPerSec > 0 ? Math.ceil(remainingBytes / speedBytesPerSec) : 0;

        const transferredFormatted = formatBytes(currentTransferStats.transferredBytes);
        const totalFormatted = formatBytes(currentTransferStats.totalBytes);
        const speedFormatted = `${formatBytes(speedBytesPerSec)}/s`;
        const etaFormatted = formatTime(etaSeconds);

        elements.transferMetrics.textContent = `${transferredFormatted} / ${totalFormatted} · ${speedFormatted} · ${etaFormatted}`;
    }, 300);
}

function stopMetricsTracker() {
    if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
    }
}

function updateProgressDisplay(percent) {
    elements.progressBar.style.width = `${percent}%`;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Memory Protected Object URLs
function createTrackedObjectURL(blobOrFile) {
    const url = URL.createObjectURL(blobOrFile);
    activeObjectUrls.add(url);
    return url;
}

// DOM Rendering Helpers
function appendFilePreview(fileName, blobOrFile, mime, direction) {
    const row = document.createElement('div');
    row.className = `msg-row ${direction}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const objectUrl = createTrackedObjectURL(blobOrFile);

    if (mime.startsWith('image/')) {
        const mediaWrap = document.createElement('div');
        mediaWrap.className = 'media-container';
        
        const img = document.createElement('img');
        img.className = 'media-preview-img';
        img.src = objectUrl;
        img.alt = fileName;
        img.onclick = () => window.open(objectUrl, '_blank');
        
        mediaWrap.appendChild(img);
        bubble.appendChild(mediaWrap);
    }

    const link = document.createElement('a');
    link.className = 'file-card';
    link.href = objectUrl;
    link.download = fileName;
    link.textContent = `💾 ${fileName}`;

    bubble.appendChild(link);
    row.appendChild(bubble);
    elements.feed.appendChild(row);
    elements.feedContainer.scrollTop = elements.feedContainer.scrollHeight;
}

function appendMessage(text, direction) {
    const row = document.createElement('div');
    row.className = `msg-row ${direction}`;
    
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;

    row.appendChild(bubble);
    elements.feed.appendChild(row);
    elements.feedContainer.scrollTop = elements.feedContainer.scrollHeight;
}

function appendSystemNotice(text) {
    const notice = document.createElement('div');
    notice.className = 'system-notice';
    notice.textContent = text;
    elements.feed.appendChild(notice);
    elements.feedContainer.scrollTop = elements.feedContainer.scrollHeight;
}

function logDiagnostic(text) {
    const timestamp = new Date().toLocaleTimeString();
    const logText = `[${timestamp}] ${text}`;
    console.log(logText);

    if (elements.debugLog) {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = logText;
        elements.debugLog.appendChild(line);
        elements.debugLog.scrollTop = elements.debugLog.scrollHeight;
    }
}

// UI State Modifiers
function setStatus(text, pillClass, faviconColor) {
    elements.statusPill.textContent = text;
    elements.statusPill.className = `timeline-pill ${pillClass}`;
    if (faviconColor) setDynamicFavicon(faviconColor);
}

function toggleInputs(connected) {
    elements.messageInput.disabled = !connected;
    elements.fileInput.disabled = !connected;
    elements.sendBtn.disabled = !connected;
    elements.connectBtn.disabled = connected;
    elements.targetId.disabled = connected;
}

function showTransferProgress(title, percent) {
    elements.transferTray.classList.remove('hidden');
    elements.transferFilename.textContent = title;
    elements.progressBar.style.width = `${percent}%`;
    setStatus('Transferring', 'pill-thinking', '#f54e00');
}

function hideTransferProgress() {
    setTimeout(() => {
        if (!isProcessingQueue && incomingTransfers.size === 0) {
            elements.transferTray.classList.add('hidden');
            elements.progressBar.style.width = '0%';
            elements.transferMetrics.textContent = '0.0 MB / 0.0 MB · 0 KB/s · --:--';
            if (activeConnection && activeConnection.open) {
                setStatus('Connected', 'pill-done', '#1f8a65');
            }
        }
    }, 800);
}

// Modals & Shortcuts
function toggleQrModal(show) {
    if (show) {
        const shareUrl = `${window.location.origin}${window.location.pathname}?peer=${elements.myId.textContent}`;
        elements.qrContainer.innerHTML = '';
        new QRCode(elements.qrContainer, {
            text: shareUrl,
            width: 160,
            height: 160,
            colorDark: "#26251e",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
        elements.qrModal.classList.remove('hidden');
    } else {
        elements.qrModal.classList.add('hidden');
    }
}

function handleBackdropClick(e) {
    if (e.target === elements.qrModal) toggleQrModal(false);
}

function toggleLogDrawer(forceState) {
    if (typeof forceState === 'boolean') {
        if (forceState) elements.logDrawer.classList.remove('hidden');
        else elements.logDrawer.classList.add('hidden');
    } else {
        elements.logDrawer.classList.toggle('hidden');
    }
}

// Global Keyboard Navigation (Esc to close)
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        toggleQrModal(false);
        toggleLogDrawer(false);
    }
});

// Clipboard Actions
function copyId() {
    navigator.clipboard.writeText(elements.myId.textContent);
    elements.copyBtn.textContent = 'Copied';
    setTimeout(() => elements.copyBtn.textContent = 'Copy ID', 1500);
}

function copyShareLink() {
    const shareUrl = `${window.location.origin}${window.location.pathname}?peer=${elements.myId.textContent}`;
    navigator.clipboard.writeText(shareUrl);
    elements.shareLinkBtn.textContent = 'Copied';
    setTimeout(() => elements.shareLinkBtn.textContent = 'Copy Link', 1500);
}

// Tab Visibility & Notifications
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        document.title = 'p2p.share — Direct Browser-to-Browser Transfer';
    }
});

function triggerBackgroundNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
            body: body,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="%23f54e00"/></svg>'
        });
    }
}

// OS Network Listeners
window.addEventListener('offline', () => {
    setStatus('No Internet', 'pill-thinking', '#dfa88f');
    appendSystemNotice('Network connection offline.');
    logDiagnostic('OS Network state: offline');
});

window.addEventListener('online', () => {
    setStatus(activeConnection && activeConnection.open ? 'Connected' : 'Ready', 
              activeConnection && activeConnection.open ? 'pill-done' : 'pill-idle', 
              activeConnection && activeConnection.open ? '#1f8a65' : '#807d72');
    appendSystemNotice('Network connection restored.');
    logDiagnostic('OS Network state: online');
});

// Guard Against Accidental Tab Closure During Transfers
window.addEventListener('beforeunload', (e) => {
    if (isProcessingQueue || incomingTransfers.size > 0) {
        e.preventDefault();
        e.returnValue = ''; // Standard browser confirmation prompt
    }
    // Clean mapped object URLs from memory
    activeObjectUrls.forEach(url => URL.revokeObjectURL(url));
    activeObjectUrls.clear();
});

initPeer();