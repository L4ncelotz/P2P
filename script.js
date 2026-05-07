const peer = new Peer(); // สร้าง Peer ID ใหม่จาก Server ของ PeerJS
let conn;

// แสดง ID ของเราเอง
peer.on('open', (id) => {
    document.getElementById('my-id').innerText = id;
});

// รอรับการเชื่อมต่อจากคนอื่น
peer.on('connection', (connection) => {
    conn = connection;
    setupChat();
});

function connectToPeer() {
    const peerId = document.getElementById('peer-id').value;
    conn = peer.connect(peerId);
    setupChat();
}

function setupChat() {
    conn.on('open', () => {
        document.getElementById('status').innerText = "Status: Connected!";
        
        conn.on('data', (data) => {
            if (data.file) {
                // รับไฟล์
                const blob = new Blob([data.file], { type: data.type });
                const url = URL.createObjectURL(blob);
                appendMessage(`Received file: <a href="${url}" download="${data.name}">${data.name}</a>`);
            } else {
                // รับข้อความ
                appendMessage(`Peer: ${data}`);
            }
        });
    });
}

function sendMessage() {
    const msg = document.getElementById('message-input').value;
    conn.send(msg);
    appendMessage(`You: ${msg}`);
}

function sendFile() {
    const file = document.getElementById('file-input').files[0];
    if (file) {
        conn.send({
            file: file,
            name: file.name,
            type: file.type
        });
        appendMessage(`You sent file: ${file.name}`);
    }
}

function appendMessage(msg) {
    const li = document.createElement('li');
    li.innerHTML = msg;
    document.getElementById('messages').appendChild(li);
}